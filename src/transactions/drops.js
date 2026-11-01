const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('./snapshot');
const threads = require('./threads');
const registry = require('./registry');
const common = require('./common');
const { contractLabel, playerLabel } = require('./format');
const { staleEntryReason, retireOnDrop } = require('./lifecycle');

/** The team's Fantrax roster item for a drop candidate, or throws a user-facing error. */
async function resolveDrop(teamName, playerId) {
  const id = fantrax.normalizeFantraxId(playerId);
  const [snap, ownership] = await Promise.all([snapshot.getSnapshot(), fantrax.fetchRosterOwnership()]);
  const fxTeam = snapshot.fantraxTeamFor(teamName, ownership);
  if (!fxTeam) throw new Error(`No Fantrax roster found for **${teamName}**.`);
  const item = fxTeam.items.find((i) => i.id === id);
  if (!item) throw new Error(`That player isn't on the ${teamName} Fantrax roster.`);
  const player = snap.directory.get(id) || { id, name: id, position: item.position, team: '' };
  return { id, item, player, label: playerLabel(player), contract: contractLabel(item) };
}

/**
 * Open a #drops thread. `linkedAddUrl` adds a "Linked add" line pointing at the add/auction thread.
 * Returns `{ thread, drop }`, or `{ error, thread }` when a drop thread is already open.
 */
async function fileDrop({ client, teamName, playerId, byUserId, linkedAddUrl, reason }) {
  const cfg = common.txnConfig();
  const drop = await resolveDrop(teamName, playerId);
  const channel = await client.channels.fetch(common.targetChannelId('drop', cfg));

  const result = await threads.withLock(threads.registryKey('drop', drop.id), async () => {
    const prev = registry.getEntry('drop', drop.id);
    const staleReason = staleEntryReason(prev, { dropCooldownHours: cfg.dropCooldownHours ?? 48 });
    if (staleReason) registry.retireEntry('drop', drop.id, staleReason);
    const existing = await threads.findThread(client, 'drop', drop.id, channel.id);
    if (existing) return { error: `There's already a drop thread for ${drop.label}:`, thread: existing };
    const thread = await threads.createThread(channel, {
      kind: 'drop',
      playerId: drop.id,
      title: common.threadTitle('drop', drop.label, cfg),
      reason,
      meta: { player: drop.player, status: 'posted', teamName, linkedAddUrl: linkedAddUrl || null },
    });
    const linkLine = linkedAddUrl ? `\nLinked add: ${linkedAddUrl}` : '';
    await threads.postInThread(
      thread,
      `${teamName} are dropping ${drop.player.name} (${drop.contract}) — <@${byUserId}>${linkLine}`,
      [byUserId],
    );
    return { thread };
  });
  if (result.error) return { ...result, channel };

  registry.recordDrop({ teamName, playerId: drop.id, playerName: drop.player.name });
  for (const kind of ['nhl', 'ahl']) {
    if (retireOnDrop(registry.getEntry(kind, drop.id))) registry.retireEntry(kind, drop.id, 'dropped');
  }
  audit('txn.drop', {
    fantraxId: `i${drop.id}`,
    player: drop.label,
    contract: drop.contract,
    teamName,
    by: byUserId,
    threadId: result.thread.id,
    linkedAddUrl: linkedAddUrl || undefined,
  });
  return { thread: result.thread, channel, drop };
}

/** `drop:` autocomplete on adds: your roster, with the group the add fills listed first. */
async function dropChoices(interaction, query, kind) {
  const { team } = common.resolveTeam(interaction);
  if (!team) return [];
  const snap = await snapshot.getSnapshot();
  const fxTeam = snapshot.fantraxTeamFor(team.teamName, snap.ownership);
  if (!fxTeam) return [];
  const q = snapshot.fold(query);
  const wantMinors = kind === 'ahl';
  return snapshot
    .rosterRows(fxTeam, snap.directory)
    .filter((r) => !q || snapshot.fold(r.name).includes(q))
    .sort((a, b) => Number((b.item.status === 'MINORS') === wantMinors) - Number((a.item.status === 'MINORS') === wantMinors))
    .slice(0, 25)
    .map((r) => ({ name: `${r.label} — ${r.contract}`.slice(0, 100), value: r.id }));
}

function teamKey(teamName) {
  return fantrax.normalizeTeamName(teamName);
}

/** Save a drop that is only filed if `teamName` wins the NHL auction for `auctionPlayerId`. */
function saveAuctionDrop(auctionPlayerId, teamName, drop, byUserId) {
  const entry = registry.getEntry('nhl', auctionPlayerId);
  const linkedDrops = { ...(entry?.linkedDrops || {}) };
  linkedDrops[teamKey(teamName)] = {
    teamName,
    playerId: drop.id,
    playerName: drop.player.name,
    label: drop.label,
    byUserId,
    at: new Date().toISOString(),
  };
  registry.upsertEntry('nhl', auctionPlayerId, { linkedDrops });
  return linkedDrops[teamKey(teamName)];
}

function auctionDropFor(entry, teamName) {
  return entry?.linkedDrops?.[teamKey(teamName)] || null;
}

module.exports = { resolveDrop, fileDrop, dropChoices, saveAuctionDrop, auctionDropFor, teamKey };
