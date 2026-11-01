const PRO_STATUSES = new Set(['ACTIVE', 'RESERVE']);

function rosterLimits(cfg = {}) {
  return {
    pro: Number(cfg.proRosterMax) || 23,
    minors: Number(cfg.minorsRosterMax) || 30,
  };
}

const PENDING_DROP_DAYS = 7;

/**
 * Roster item ids this team has filed a drop for (within the last week) that Fantrax still shows.
 * They are leaving, so they don't take a spot.
 */
function pendingDropIds(drops, teamName, items = [], now = Date.now()) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const cutoff = now - PENDING_DROP_DAYS * 24 * 60 * 60 * 1000;
  const onRoster = new Set(items.map((i) => i.id));
  const ids = new Set();
  for (const d of drops || []) {
    if (norm(d.teamName) !== norm(teamName)) continue;
    if (Date.parse(d.at || 0) < cutoff) continue;
    if (onRoster.has(d.playerId)) ids.add(d.playerId);
  }
  return ids;
}

/** Counts by Fantrax slot: pro = Active + Reserve (IR and Minors excluded), minors = Minors slot. */
function countRoster(items = [], { exclude } = {}) {
  let pro = 0;
  let ir = 0;
  let minors = 0;
  for (const item of items) {
    if (exclude?.has(item.id)) continue;
    if (PRO_STATUSES.has(item.status)) pro++;
    else if (item.status === 'INJURED_RESERVE') ir++;
    else if (item.status === 'MINORS') minors++;
  }
  return { pro, ir, minors };
}

/** `nhl` adds fill a pro spot; `ahl` adds fill a minors spot. */
function rosterFull(kind, counts, limits) {
  if (kind === 'nhl') return counts.pro >= limits.pro;
  if (kind === 'ahl') return counts.minors >= limits.minors;
  return false;
}

function fullRosterNotice(kind, counts, limits, playerName, { auction = false } = {}) {
  const [group, have, max] =
    kind === 'nhl' ? ['pro', counts.pro, limits.pro] : ['minors', counts.minors, limits.minors];
  const tail = auction ? ' The linked drop is only filed if you win the auction.' : '';
  return (
    `Your ${group} roster is full (${have}/${max}). You'll likely need a drop to make room for **${playerName}**. ` +
    `To link one to this add, run \`/drop-player player:<who> for_add:${playerName}\`.${tail}`
  );
}

function spotsLine(counts, limits) {
  const nhlOpen = Math.max(0, limits.pro - counts.pro);
  const ahlOpen = Math.max(0, limits.minors - counts.minors);
  return (
    `**NHL Spots: ${nhlOpen} open (${counts.pro}/${limits.pro})  ·  ` +
    `AHL Spots: ${ahlOpen} open (${counts.minors}/${limits.minors})**`
  );
}

/** Roster rows split into the NHL list (pro + IR) and the minors list, with display tags. */
function splitRosterRows(rows, { pendingDrops } = {}) {
  const nhl = [];
  const minors = [];
  for (const row of rows) {
    const status = row.item?.status;
    const dropTag = pendingDrops?.has(row.item?.id) ? ['drop pending'] : [];
    if (status === 'MINORS') {
      minors.push({ ...row, tags: dropTag });
      continue;
    }
    const tags = [...dropTag];
    if (status === 'INJURED_RESERVE') tags.push('IR');
    if (String(row.item?.contract || '').toLowerCase() === 'minors') tags.push('uncalled minors');
    nhl.push({ ...row, tags });
  }
  return { nhl, minors };
}

module.exports = {
  rosterLimits,
  pendingDropIds,
  countRoster,
  rosterFull,
  fullRosterNotice,
  spotsLine,
  splitRosterRows,
};
