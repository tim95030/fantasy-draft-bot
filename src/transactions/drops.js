const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('./snapshot');
const threads = require('./threads');
const registry = require('./registry');
const common = require('./common');
const { contractLabel, playerLabel } = require('./format');
const { staleEntryReason, retireOnDrop } = require('./lifecycle');
const { pendingDropIds, countRoster, rosterLimits } = require('./roster');

/** The team's Fantrax roster item for a drop candidate, or throws a user-facing error. */
async function resolveDrop(teamName, playerId, inputContext) {
  const [snap, ownership] = await Promise.all([snapshot.getSnapshot(), fantrax.fetchRosterOwnership()]);
  const fxTeam = snapshot.fantraxTeamFor(teamName, ownership);
  if (!fxTeam) throw new Error(`No Fantrax roster found for **${teamName}**.`);
  const id = snapshot.rosterIdFromInput(fxTeam, snap.directory, playerId, inputContext);
  const item = fxTeam.items.find((i) => i.id === id);
  if (!item) throw new Error(`That player isn't on the ${teamName} Fantrax roster.`);
  const player = snap.directory.get(id) || { id, name: id, position: item.position, team: '' };
  return { id, item, player, label: playerLabel(player), contract: contractLabel(item) };
}

/**
 * Open a #drops thread. `linkedAddUrl` adds a "Linked add" line pointing at the add/auction thread.
 * Reuses an active existing drop for linked adds. Plain duplicate drops return `{ error, thread }`.
 */
async function fileDrop({ client, teamName, playerId, byUserId, linkedAddUrl, reason, inputContext }) {
  const cfg = common.txnConfig();
  const drop = await resolveDrop(teamName, playerId, inputContext);
  const channel = await client.channels.fetch(common.targetChannelId('drop', cfg));

  const result = await threads.withLock(threads.registryKey('drop', drop.id), async () => {
    const prev = registry.getEntry('drop', drop.id);
    const staleReason = staleEntryReason(prev, { dropCooldownHours: cfg.dropCooldownHours ?? 48 });
    if (staleReason) registry.retireEntry('drop', drop.id, staleReason);
    const existing = await threads.findThread(client, 'drop', drop.id, channel.id);
    if (existing) {
      if (!linkedAddUrl) return { error: `There's already a drop thread for ${drop.label}:`, thread: existing };
      if (existing.archived) return { error: `The drop thread for ${drop.label} is archived; it cannot be linked:`, thread: existing };
      const linkedAddUrls = [...new Set([...(prev?.linkedAddUrls || []), prev?.linkedAddUrl].filter(Boolean))];
      if (!linkedAddUrls.includes(linkedAddUrl)) {
        await threads.postInThread(existing, `Linked add: ${linkedAddUrl}`);
        registry.upsertEntry('drop', drop.id, { linkedAddUrls: [...linkedAddUrls, linkedAddUrl] });
      }
      return { thread: existing, reused: true };
    }
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
  if (result.reused) return { ...result, channel, drop };

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

/** Roster counts for a Fantrax team, not counting players it already filed drops for. */
function teamRosterState(fxTeam, teamName, cfg = common.txnConfig()) {
  const pendingDrops = pendingDropIds(registry.loadDrops(), teamName, fxTeam?.items);
  return {
    items: fxTeam?.items || [],
    pendingDrops,
    counts: countRoster(fxTeam?.items, { exclude: pendingDrops }),
    limits: rosterLimits(cfg),
  };
}

function teamKey(teamName) {
  return fantrax.normalizeTeamName(teamName);
}

/** Save a drop that is only filed if `teamName` wins the NHL auction for `auctionPlayerId`. */
function saveAuctionDrop(auctionPlayerId, teamName, drop, byUserId) {
  const entry = registry.getEntry('nhl', auctionPlayerId);
  if (entry?.status !== 'open') throw new Error('This auction is no longer open. Link the drop again with /drop-player for_add:.');
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

module.exports = {
  resolveDrop,
  fileDrop,
  dropChoices,
  teamRosterState,
  saveAuctionDrop,
  auctionDropFor,
  teamKey,
};
