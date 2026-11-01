const PRO_STATUSES = new Set(['ACTIVE', 'RESERVE']);

function rosterLimits(cfg = {}) {
  return {
    pro: Number(cfg.proRosterMax) || 23,
    minors: Number(cfg.minorsRosterMax) || 30,
  };
}

/** Counts by Fantrax slot: pro = Active + Reserve (IR and Minors excluded), minors = Minors slot. */
function countRoster(items = []) {
  let pro = 0;
  let ir = 0;
  let minors = 0;
  for (const item of items) {
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
function splitRosterRows(rows) {
  const nhl = [];
  const minors = [];
  for (const row of rows) {
    const status = row.item?.status;
    if (status === 'MINORS') {
      minors.push({ ...row, tags: [] });
      continue;
    }
    const tags = [];
    if (status === 'INJURED_RESERVE') tags.push('IR');
    if (String(row.item?.contract || '').toLowerCase() === 'minors') tags.push('uncalled minors');
    nhl.push({ ...row, tags });
  }
  return { nhl, minors };
}

module.exports = { rosterLimits, countRoster, rosterFull, fullRosterNotice, spotsLine, splitRosterRows };
