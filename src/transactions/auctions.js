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
const { postInThread } = require('./threads');

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

async function scanThreadForHighBid(thread, ineligibleIds = []) {
  const ineligible = new Set(ineligibleIds.map(String));
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
  registry.upsertEntry('nhl', playerId, { highBid, closeAt });
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
    registry.upsertEntry('nhl', playerId, { status: 'closed', closedAt: new Date().toISOString() });
    return;
  }

  const ineligible = entry.ineligibleUserIds || [];
  let winner = entry.highBid;
  if (winner && ineligible.map(String).includes(String(winner.userId))) winner = null;
  if (!winner) winner = await scanThreadForHighBid(thread, ineligible);

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

async function handleWinnerYears(message, entry) {
  if (String(message.author.id) !== String(entry.winner?.userId)) return;
  const years = parseContractYears(message.content);
  if (!years) {
    await message
      .reply({
        content: 'Reply with a number from **1** to **6** (e.g. `3` or `4 years`).',
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
    return;
  }
  const yearsErr = validateYears(years);
  if (yearsErr) {
    await message.reply({ content: yearsErr, allowedMentions: { parse: [] } }).catch(() => {});
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
  const lockNote = locked
    ? 'This thread is **locked** — no further posts until the commish finishes in Fantrax and **archives** the thread here.'
    : '**Commish:** lock or archive this thread after Fantrax is updated (bot needs **Manage Threads** to lock automatically).';

  await message.reply({
    content:
      `**${label}** — **${formatSalary(entry.winner.amount)}** for **${years} year${years === 1 ? '' : 's'}** ` +
      `(<@${entry.winner.userId}>). Commish: add in Fantrax.\n\n${lockNote}`,
    allowedMentions: { users: [entry.winner.userId] },
  });
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
  if (entry.status === 'won') return;
  if (entry.status !== 'open') return;

  const parsed = parseBidMessage(message.content);
  if (!parsed?.amount) return;

  const cfg = txnConfig();
  const prevHigh = entry.highBid?.amount || 0;
  const amountErr = validateBidAmount(parsed.amount, prevHigh, cfg);
  if (amountErr) {
    await message.reply({ content: amountErr, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }

  let teamName = null;
  const teamMatch = String(message.content).match(/\(([^)]+)\)\s*$/);
  if (teamMatch) teamName = teamMatch[1].trim();
  if (!teamName) {
    const owned = findTeamsForUser(loadOrder(), message.author.id);
    if (owned.length === 1) teamName = owned[0].teamName;
  }
  if (!teamName) {
    await message
      .reply({
        content:
          'Include your team at the end, e.g. `950k — @you (New York Rangers)`, or use `/nhl-add`.',
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
    return;
  }

  const result = await applyBid({
    kind: 'nhl',
    playerId: entry.playerId,
    amount: parsed.amount,
    userId: message.author.id,
    teamName,
    messageId: message.id,
  });
  if (result.error) {
    await message.reply({ content: result.error, allowedMentions: { parse: [] } }).catch(() => {});
  }
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
  formatBidLine,
};
