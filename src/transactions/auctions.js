const { audit } = require('../draft/audit');
const { formatSalary, playerLabel } = require('./format');
const {
  parseBidMessage,
  parseContractYears,
  validateBidAmount,
  validateYears,
  formatBidLine,
} = require('./bids');
const registry = require('./registry');
const { txnConfig } = require('./common');
const { loadOrder, findTeamsForUser } = require('../draft/order');
const threads = require('./threads');
const { postInThread } = threads;
const {
  setWinnerOnlyPosting,
  clearThreadPostingOverrides,
  ensureCommishThreadAccess,
} = require('./threadPerms');
const { isTxnCommish } = require('../config');

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const TICK_MS = 60 * 1000;

/** `auctionMinutes` in config overrides `auctionHours` when set (for testing). */
function auctionCloseMs(cfg = txnConfig()) {
  const min = Number(cfg.auctionMinutes);
  if (Number.isFinite(min) && min > 0) return min * MIN_MS;
  return (cfg.auctionHours ?? 24) * HOUR_MS;
}

function resyncOpenAuctionDeadlines() {
  const ms = auctionCloseMs();
  for (const entry of registry.listOpenAuctions('nhl')) {
    const base = Date.parse(entry.highBid?.at || entry.createdAt || 0);
    if (!Number.isFinite(base)) continue;
    const closeAt = new Date(base + ms).toISOString();
    registry.upsertEntry('nhl', entry.playerId, { closeAt });
    scheduleClose(registry.getEntry('nhl', entry.playerId));
  }
}
const MAX_SCAN_MESSAGES = 1000;

let client = null;
let tickTimer = null;
const closeTimers = new Map();

function bindClient(c) {
  client = c;
}

async function lockThreadPendingCommish(thread) {
  try {
    await thread.setLocked(true);
    return true;
  } catch (err) {
    console.warn('Could not lock NHL auction thread:', err.message);
    return false;
  }
}

function entryByThreadId(threadId) {
  const reg = registry.loadRegistry();
  return Object.values(reg).find((e) => e.threadId === threadId && e.kind === 'nhl') || null;
}

function scheduleClose(entry) {
  if (!entry?.closeAt || entry.status !== 'open') return;
  const key = entry.playerId;
  if (closeTimers.has(key)) clearTimeout(closeTimers.get(key));
  const ms = Math.max(0, Date.parse(entry.closeAt) - Date.now());
  const handle = setTimeout(() => {
    closeTimers.delete(key);
    closeAuction(key).catch((err) => console.error('Auction close failed:', err.message));
  }, Math.min(ms, 2_147_483_647));
  closeTimers.set(key, handle);
}

function rescheduleAll() {
  for (const entry of registry.listOpenAuctions('nhl')) scheduleClose(entry);
}

async function scanThreadForHighBid(thread, ineligibleIds = [], opts = {}) {
  const ineligible = new Set(ineligibleIds.map(String));
  const excludeMessageIds = new Set((opts.excludeMessageIds || []).map(String));
  const botOfficialOnly = opts.botOfficialOnly !== false;
  const cfg = txnConfig();
  let best = null;
  let before;
  let scanned = 0;
  let prevHigh = 0;

  while (scanned < MAX_SCAN_MESSAGES) {
    const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    const chronological = [...batch.values()].reverse();
    for (const msg of chronological) {
      if (excludeMessageIds.has(String(msg.id))) continue;
      if (botOfficialOnly && !msg.author?.bot) continue;
      const parsed = parseBidMessage(msg.content);
      if (!parsed?.amount) continue;
      const amountErr = validateBidAmount(parsed.amount, prevHigh, cfg);
      if (amountErr) continue;
      if (ineligible.has(String(msg.author.id))) continue;
      prevHigh = parsed.amount;
      const teamMatch = String(msg.content).match(/\(([^)]+)\)\s*$/);
      best = {
        amount: parsed.amount,
        userId: msg.author.id,
        teamName: teamMatch ? teamMatch[1].trim() : '',
        messageId: msg.id,
        at: msg.createdAt?.toISOString?.() || new Date().toISOString(),
      };
    }
    scanned += batch.size;
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return best;
}

/** Reconcile registry high bid from official bot bid lines in the thread (not raw GM posts). */
async function syncHighBidFromThread(thread, entry, opts = {}) {
  if (!thread || !entry?.playerId) return entry;
  if (entry.highBidManual) return entry;
  const scanned = await scanThreadForHighBid(thread, entry.ineligibleUserIds || [], {
    botOfficialOnly: true,
    ...opts,
  });
  const regAmt = entry.highBid?.amount || 0;
  if (!scanned?.amount || scanned.amount <= regAmt) return entry;
  registry.upsertEntry('nhl', entry.playerId, { highBid: scanned });
  return registry.getEntry('nhl', entry.playerId);
}

async function applyBid({ kind, playerId, amount, userId, teamName, messageId }) {
  if (kind !== 'nhl') return { error: 'Only NHL auctions use bidding.' };
  const cfg = txnConfig();
  const entry = registry.getEntry('nhl', playerId);
  if (!entry) return { error: 'This auction is not open.' };
  if (entry.status && entry.status !== 'open') return { error: 'This auction is not open.' };
  if ((entry.ineligibleUserIds || []).map(String).includes(String(userId))) {
    return { error: 'You are ineligible to win this player (edited bid). You cannot place new bids.' };
  }
  if (entry.highBid?.userId && String(entry.highBid.userId) === String(userId)) {
    return { error: 'You already hold the high bid. Wait for someone else to outbid you.' };
  }

  const prevHigh = entry.highBid?.amount || 0;
  const amountErr = validateBidAmount(amount, prevHigh, cfg);
  if (amountErr) return { error: amountErr };

  const closeAt = new Date(Date.now() + auctionCloseMs(cfg)).toISOString();
  const highBid = {
    amount,
    userId: String(userId),
    teamName,
    messageId: messageId || null,
    at: new Date().toISOString(),
  };
  registry.upsertEntry('nhl', playerId, { highBid, closeAt, highBidManual: false });
  const updated = registry.getEntry('nhl', playerId);
  scheduleClose(updated);

  audit('txn.nhl_bid', {
    fantraxId: `i${playerId}`,
    amount,
    teamName,
    by: userId,
    closeAt,
    threadId: entry.threadId,
  });

  return { entry: updated, previous: prevHigh };
}

async function closeAuction(playerId) {
  if (!client) return;
  const entry = registry.getEntry('nhl', playerId);
  if (!entry || entry.status !== 'open') return;
  if (entry.closeAt && Date.parse(entry.closeAt) > Date.now()) return;

  let thread;
  try {
    thread = await client.channels.fetch(entry.threadId);
  } catch {
    registry.retireEntry('nhl', playerId, 'thread_missing_at_close');
    audit('txn.nhl_retired', {
      fantraxId: `i${playerId}`,
      reason: 'thread_missing_at_close',
      threadId: entry.threadId,
      highBid: entry.highBid || null,
    });
    return;
  }

  const ineligible = entry.ineligibleUserIds || [];
  let winner = entry.highBid;
  if (winner && ineligible.map(String).includes(String(winner.userId))) winner = null;
  if (!winner) winner = await scanThreadForHighBid(thread, ineligible, { botOfficialOnly: true });

  const label = entry.player ? playerLabel(entry.player) : playerId;
  if (winner) {
    registry.upsertEntry('nhl', playerId, {
      status: 'awaiting_years',
      closedAt: new Date().toISOString(),
      winner,
    });
    const line =
      `**Auction closed** — <@${winner.userId}> won **${label}** for **${formatSalary(winner.amount)}** ` +
      `(${winner.teamName || 'your team'}).\n\n` +
      `<@${winner.userId}> Reply in this thread with contract length (**1**–**6** years), e.g. \`3\` or \`3 years\`.`;
    await postInThread(thread, line, [winner.userId]);
    const winnerOnly = await setWinnerOnlyPosting(thread, winner.userId);
    if (!winnerOnly) {
      console.warn(
        `setWinnerOnlyPosting failed for thread ${entry.threadId}; non-winner posts are still removed by the bot.`,
      );
    }
    audit('txn.nhl_won', {
      fantraxId: `i${playerId}`,
      player: label,
      amount: winner.amount,
      userId: winner.userId,
      teamName: winner.teamName,
      threadId: entry.threadId,
      awaitingYears: true,
    });
  } else {
    registry.upsertEntry('nhl', playerId, {
      status: 'closed',
      closedAt: new Date().toISOString(),
      winner: null,
    });
    await postInThread(thread, `**Auction closed** — no valid winning bid for **${label}**.`);
    audit('txn.nhl_closed', { fantraxId: `i${playerId}`, player: label, threadId: entry.threadId });
  }
}

async function notifyYearsUser(message, content, { extra } = {}) {
  const tail = extra ? `\n\n${extra}` : '';
  const body = `${content}${tail}\n\n_Reply in this thread with contract length (**1**–**6**), e.g. \`3\` or \`4 years\`._`;
  try {
    await message.author.send(body);
    return;
  } catch {
    // DMs closed
  }
  try {
    const reply = await message.channel.send({
      content: `<@${message.author.id}> ${content}`,
      allowedMentions: { users: [message.author.id] },
    });
    setTimeout(() => {
      reply.delete().catch(() => {});
    }, 45_000);
  } catch {
    // ignore
  }
}

async function handleWinnerYears(message, entry) {
  const isWinner = String(message.author.id) === String(entry.winner?.userId);
  if (!isWinner) {
    await deleteUserMessage(message);
    return;
  }

  const years = parseContractYears(message.content);
  if (!years) {
    await deleteUserMessage(message);
    await notifyYearsUser(
      message,
      'Reply with a number from **1** to **6** (e.g. `3` or `4 years`).',
    );
    return;
  }
  const yearsErr = validateYears(years);
  if (yearsErr) {
    await deleteUserMessage(message);
    await notifyYearsUser(message, yearsErr);
    return;
  }

  const label = entry.player ? playerLabel(entry.player) : entry.playerId;
  registry.upsertEntry('nhl', entry.playerId, {
    status: 'won',
    contractYears: years,
    contractAt: new Date().toISOString(),
    winner: { ...entry.winner, years },
  });

  const locked = await lockThreadPendingCommish(message.channel);
  if (locked) {
    await clearThreadPostingOverrides(message.channel, entry.winner.userId);
    await ensureCommishThreadAccess(message.channel);
  }
  const lockNote = locked
    ? 'This thread is **locked** — no further posts until the commish finishes in Fantrax and **archives** the thread here.'
    : '**Commish:** lock or archive this thread after Fantrax is updated (bot needs **Manage Threads** to lock automatically).';

  await postInThread(
    message.channel,
    `**${label}** — **${formatSalary(entry.winner.amount)}** for **${years} year${years === 1 ? '' : 's'}** ` +
      `(<@${entry.winner.userId}>). Commish: add in Fantrax.\n\n${lockNote}`,
    [entry.winner.userId],
  );
  const removed = await deleteUserMessage(message);
  if (!removed) await notifyYearsUser(message, 'Contract years recorded.', { extra: MANAGE_MESSAGES_HINT });

  audit('txn.nhl_contract', {
    fantraxId: `i${entry.playerId}`,
    player: label,
    amount: entry.winner.amount,
    years,
    userId: entry.winner.userId,
    teamName: entry.winner.teamName,
    threadId: entry.threadId,
  });
}

async function tick() {
  const now = Date.now();
  for (const entry of registry.listOpenAuctions('nhl')) {
    if (entry.closeAt && Date.parse(entry.closeAt) <= now) {
      await closeAuction(entry.playerId);
    }
  }
}

function startScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  resyncOpenAuctionDeadlines();
  tickTimer = setInterval(() => tick().catch((e) => console.error(e.message)), TICK_MS);
}

const MANAGE_MESSAGES_HINT =
  'Ask commish to allow the bot **Manage Messages** on **#nhl-adds** (channel permission on the bot role, not per-thread).';

async function deleteUserMessage(message) {
  try {
    if (!message.deletable) return false;
    await message.delete();
    return true;
  } catch {
    return false;
  }
}

function threadJumpUrl(message) {
  const guildId = message.guild?.id;
  const threadId = message.channel?.id;
  if (!guildId || !threadId) return null;
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

function nhlBidAssistBlock(message, entry, { amount, teamName } = {}) {
  const label = entry?.player ? playerLabel(entry.player) : entry?.title || entry?.playerId || 'this player';
  const sal = amount != null ? formatSalary(amount) : null;
  const owned = findTeamsForUser(loadOrder(), message.author.id);
  const team =
    teamName ||
    (owned.length === 1 ? owned[0].teamName : null);
  const lines = [];
  const url = threadJumpUrl(message);
  if (url) lines.push(`**Auction thread:** ${url}`);
  const salaryHint = sal || 'your bid';
  let slash = `\`/nhl-add\` → player **${label}** → salary **${salaryHint}**`;
  if (owned.length > 1) slash += ' → `for_team` (your fantasy team)';
  else if (team) slash += ` → (for **${team}**)`;
  lines.push(`**Try again:** ${slash}`);
  const threadBid = team ? `${salaryHint} (${team})` : `${salaryHint} (Your Team)`;
  lines.push(`**Or in that thread:** \`${threadBid}\``);
  return lines.join('\n');
}

async function notifyBidUser(message, content, { extra, entry, amount, teamName } = {}) {
  const tail = extra ? `\n\n${extra}` : '';
  const assist = entry ? `\n\n${nhlBidAssistBlock(message, entry, { amount, teamName })}` : '';
  const body = `${content}${tail}${assist}`;
  try {
    await message.author.send(body);
    return;
  } catch {
    // DMs closed
  }
  try {
    const shortAssist = entry ? nhlBidAssistBlock(message, entry, { amount, teamName }) : '';
    const replyBody = shortAssist ? `${content}\n\n${shortAssist}` : content;
    const reply = await message.channel.send({
      content: `<@${message.author.id}> ${replyBody}`.slice(0, 2000),
      allowedMentions: { users: [message.author.id] },
    });
    setTimeout(() => {
      reply.delete().catch(() => {});
    }, 45_000);
  } catch {
    // ignore
  }
}

function resolveBidTeamName(message, content) {
  const teamMatch = String(content).match(/\(([^)]+)\)\s*$/);
  if (teamMatch) return teamMatch[1].trim();
  const owned = findTeamsForUser(loadOrder(), message.author.id);
  if (owned.length === 1) return owned[0].teamName;
  return null;
}

async function handleOpenAuctionBid(message, entry) {
  const content = String(message.content || '').trim();
  const parsed = parseBidMessage(content);
  if (!parsed?.amount) {
    await deleteUserMessage(message);
    return;
  }

  const cfg = txnConfig();
  const amount = parsed.amount;
  let teamName = resolveBidTeamName(message, content);

  let fresh = registry.getEntry('nhl', entry.playerId) || entry;
  fresh = await syncHighBidFromThread(message.channel, fresh, {
    excludeMessageIds: [message.id],
  });
  const prevHigh = fresh.highBid?.amount || 0;
  const amountErr = validateBidAmount(amount, prevHigh, cfg);
  if (amountErr) {
    await deleteUserMessage(message);
    await notifyBidUser(message, amountErr, { entry, amount });
    return;
  }
  if (!teamName) {
    await deleteUserMessage(message);
    await notifyBidUser(message, 'Include your fantasy team at the end, e.g. `950k (New York Rangers)`.', {
      entry,
      amount,
    });
    return;
  }

  const result = await threads.withLock(threads.registryKey('nhl', entry.playerId), async () => {
    let current = registry.getEntry('nhl', entry.playerId);
    if (!current || current.status !== 'open') {
      return { error: 'This auction is not open.' };
    }
    current = await syncHighBidFromThread(message.channel, current, {
      excludeMessageIds: [message.id],
    });
    const liveHigh = current.highBid?.amount || 0;
    const liveErr = validateBidAmount(amount, liveHigh, cfg);
    if (liveErr) return { error: liveErr };

    const bid = await applyBid({
      kind: 'nhl',
      playerId: entry.playerId,
      amount,
      userId: message.author.id,
      teamName,
    });
    if (bid.error) return { error: bid.error };

    const line = formatBidLine(amount, message.author.id, teamName);
    const posted = await postInThread(message.channel, line, [message.author.id]);
    registry.upsertEntry('nhl', entry.playerId, {
      highBid: { ...registry.getEntry('nhl', entry.playerId).highBid, messageId: posted.id },
    });
    return { ok: true };
  });

  const removed = await deleteUserMessage(message);
  const deleteHint = removed ? null : MANAGE_MESSAGES_HINT;
  if (result.error) {
    await notifyBidUser(message, result.error, { extra: deleteHint, entry, amount, teamName });
  } else if (!removed && result.ok) {
    await notifyBidUser(message, 'Bid posted.', { extra: deleteHint, entry, amount, teamName });
  }
}

async function markBidEdited(threadId, authorId) {
  const entry = entryByThreadId(threadId);
  if (!entry || entry.status !== 'open') return;
  const ids = [...new Set([...(entry.ineligibleUserIds || []), String(authorId)])];
  registry.upsertEntry('nhl', entry.playerId, { ineligibleUserIds: ids });
  const thread = await client?.channels.fetch(threadId).catch(() => null);
  if (thread) {
    await postInThread(
      thread,
      `<@${authorId}> edited a bid message and is **ineligible to win** this player per league rules.`,
      [authorId],
    );
  }
  audit('txn.nhl_bid_edited', { playerId: entry.playerId, userId: authorId, threadId });
}

async function handleThreadMessage(message) {
  if (!message.guild || message.author?.bot) return;
  const entry = entryByThreadId(message.channel.id);
  if (!entry) return;

  if (entry.status === 'awaiting_years') {
    await handleWinnerYears(message, entry);
    return;
  }

  if (isTxnCommish(message.author.id)) return;

  if (entry.status === 'won') {
    await deleteUserMessage(message);
    return;
  }
  if (entry.status !== 'open') return;

  await handleOpenAuctionBid(message, entry);
}

module.exports = {
  bindClient,
  startScheduler,
  scheduleClose,
  applyBid,
  closeAuction,
  markBidEdited,
  handleThreadMessage,
  entryByThreadId,
  scanThreadForHighBid,
  syncHighBidFromThread,
  formatBidLine,
};
