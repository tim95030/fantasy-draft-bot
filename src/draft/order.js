const fs = require('fs');
const paths = require('../paths');

const DEFAULT_TEAM_COUNT = 32;

function ensureOrderFile() {
  if (!fs.existsSync(paths.ORDER_JSON)) {
    if (fs.existsSync(paths.ORDER_SAMPLE)) {
      fs.copyFileSync(paths.ORDER_SAMPLE, paths.ORDER_JSON);
    } else {
      fs.writeFileSync(
        paths.ORDER_JSON,
        JSON.stringify(
          { snake: true, allowDuplicateOwners: false, teams: [] },
          null,
          2,
        ),
      );
    }
  }
}

/**
 * Normalize legacy `{ discordUserId, displayName }` rows into
 * `{ teamName, owners: [{ discordUserId, displayName }] }`.
 */
function normalizeTeam(raw, index = 0) {
  if (!raw || typeof raw !== 'object') {
    return { teamName: `Team ${index + 1}`, owners: [] };
  }

  const teamName = String(raw.teamName || raw.displayName || `Team ${index + 1}`).trim();

  if (Array.isArray(raw.owners) && raw.owners.length) {
    return {
      teamName,
      owners: raw.owners
        .map((o) => ({
          discordUserId: String(o.discordUserId || o.id || '')
            .replace(/[<@!>]/g, '')
            .trim(),
          displayName: String(o.displayName || o.name || '').trim(),
        }))
        .filter((o) => o.discordUserId),
    };
  }

  // Legacy single-owner shape
  if (raw.discordUserId) {
    return {
      teamName,
      owners: [
        {
          discordUserId: String(raw.discordUserId).replace(/[<@!>]/g, '').trim(),
          displayName: String(raw.displayName || '').trim(),
        },
      ],
    };
  }

  return { teamName, owners: [] };
}

function loadOrder() {
  ensureOrderFile();
  const raw = JSON.parse(fs.readFileSync(paths.ORDER_JSON, 'utf8'));
  const teams = (Array.isArray(raw.teams) ? raw.teams : []).map((t, i) =>
    normalizeTeam(t, i),
  );
  return {
    snake: Boolean(raw.snake),
    allowDuplicateOwners: Boolean(raw.allowDuplicateOwners),
    teams,
  };
}

function saveOrder(order) {
  const normalized = {
    snake: Boolean(order.snake),
    allowDuplicateOwners: Boolean(order.allowDuplicateOwners),
    teams: (order.teams || []).map((t, i) => normalizeTeam(t, i)),
  };
  fs.writeFileSync(paths.ORDER_JSON, JSON.stringify(normalized, null, 2));
  return normalized;
}

function ownerIds(team) {
  return (team?.owners || []).map((o) => String(o.discordUserId));
}

function teamOwnedBy(team, discordUserId) {
  return ownerIds(team).includes(String(discordUserId));
}

function formatOwners(team) {
  const owners = team?.owners || [];
  if (!owners.length) return '_no owners_';
  return owners.map((o) => `<@${o.discordUserId}>`).join(' ');
}

function formatTeamLine(team, index) {
  return `**${index + 1}.** ${team.teamName} — ${formatOwners(team)}`;
}

/**
 * @param {object} order
 * @param {{ allowDuplicateOwners?: boolean, expectedCount?: number|null }} [opts]
 */
function validateOrder(order, opts = {}) {
  const teams = order.teams || [];
  const allowDup =
    opts.allowDuplicateOwners != null
      ? opts.allowDuplicateOwners
      : Boolean(order.allowDuplicateOwners);

  if (opts.expectedCount != null && teams.length !== opts.expectedCount) {
    return `Draft order must have exactly ${opts.expectedCount} teams (found ${teams.length}).`;
  }
  if (teams.length < 1) {
    return 'Draft order must have at least 1 team.';
  }

  const seen = new Set();
  for (let i = 0; i < teams.length; i += 1) {
    const t = normalizeTeam(teams[i], i);
    if (!t.teamName) return `Team #${i + 1} missing teamName`;
    if (!t.owners.length) {
      return `Team #${i + 1} (${t.teamName}) needs at least one owner.`;
    }
    for (const o of t.owners) {
      if (!o.discordUserId) {
        return `Team #${i + 1} (${t.teamName}) has an owner missing discordUserId`;
      }
      const id = String(o.discordUserId);
      if (!allowDup && seen.has(id)) {
        return `Duplicate owner <@${id}> at team #${i + 1} (${t.teamName}). Enable allow_duplicate_owners to allow this for testing.`;
      }
      seen.add(id);
    }
  }
  return null;
}

/**
 * Resize team list (pad or truncate). Only for idle drafts.
 */
function resizeTeams(order, count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    throw new Error('Team count must be an integer from 1 to 64.');
  }
  const teams = [...(order.teams || []).map((t, i) => normalizeTeam(t, i))];
  if (n < teams.length) {
    teams.length = n;
  } else {
    while (teams.length < n) {
      const i = teams.length;
      teams.push({ teamName: `Team ${String(i + 1).padStart(2, '0')}`, owners: [] });
    }
  }
  return { ...order, teams };
}

/**
 * Draft-order index (0-based) for a given round.pick in a snake/linear queue.
 */
function teamIndexForPick({ teamCount, snake, startRound, round, pick }) {
  const n = Number(teamCount);
  const r = Number(round) - Number(startRound);
  const i = Number(pick) - 1;
  if (!Number.isInteger(n) || n < 1) return null;
  if (!Number.isInteger(r) || r < 0) return null;
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  const reverse = Boolean(snake) && r % 2 === 1;
  return reverse ? n - 1 - i : i;
}

/**
 * Build the full pick queue for the active draft window.
 */
function buildQueue({ teams, snake, startRound, totalRounds }) {
  const queue = [];
  const normalized = teams.map((t, i) => normalizeTeam(t, i));
  const n = normalized.length;
  for (let r = 0; r < totalRounds; r += 1) {
    const round = startRound + r;
    const reverse = snake && r % 2 === 1;
    const order = reverse ? [...normalized].reverse() : normalized;
    for (let i = 0; i < n; i += 1) {
      const team = order[i];
      const teamIndex = reverse ? n - 1 - i : i;
      const ids = ownerIds(team);
      queue.push({
        round,
        pick: i + 1,
        teamIndex,
        teamName: team.teamName,
        ownerIds: ids,
        // Primary id kept for older call sites / export compatibility
        discordUserId: ids[0] || '',
        displayName: team.teamName,
        overallIndex: queue.length,
      });
    }
  }
  return queue;
}

/**
 * Stamp live order team name/owners onto a queue, skip, or pick record.
 * Returns true if any field changed.
 */
function applyLiveTeam(slot, order, { snake, startRound } = {}) {
  if (!slot || !order?.teams?.length) return false;
  let idx = Number.isInteger(slot.teamIndex) ? slot.teamIndex : null;
  if (idx == null || idx < 0 || idx >= order.teams.length) {
    idx = teamIndexForPick({
      teamCount: order.teams.length,
      snake: snake ?? order.snake,
      startRound: startRound ?? 1,
      round: slot.round,
      pick: slot.pick,
    });
  }
  if (idx == null || idx < 0 || idx >= order.teams.length) return false;

  const team = normalizeTeam(order.teams[idx], idx);
  const ids = ownerIds(team);
  let changed = false;
  if (slot.teamIndex !== idx) {
    slot.teamIndex = idx;
    changed = true;
  }
  if (slot.teamName !== team.teamName) {
    slot.teamName = team.teamName;
    changed = true;
  }
  if (slot.displayName !== team.teamName) {
    slot.displayName = team.teamName;
    changed = true;
  }
  const prevIds = Array.isArray(slot.ownerIds) ? slot.ownerIds.map(String).join(',') : '';
  const nextIds = ids.map(String).join(',');
  if (prevIds !== nextIds) {
    slot.ownerIds = ids;
    changed = true;
  }
  const primary = ids[0] || '';
  if (String(slot.discordUserId || '') !== primary) {
    slot.discordUserId = primary;
    changed = true;
  }
  return changed;
}

function slotOwnedBy(slot, discordUserId) {
  if (!slot) return false;
  const id = String(discordUserId);
  if (Array.isArray(slot.ownerIds) && slot.ownerIds.map(String).includes(id)) return true;
  return String(slot.discordUserId) === id;
}

function findTeamsForUser(order, discordUserId) {
  return (order.teams || [])
    .map((t, i) => normalizeTeam(t, i))
    .filter((t) => teamOwnedBy(t, discordUserId));
}

/** First matching team (legacy helper). */
function findTeam(order, discordUserId) {
  return findTeamsForUser(order, discordUserId)[0] || null;
}

function findTeamByName(order, teamName) {
  const want = String(teamName || '')
    .trim()
    .toLowerCase();
  return (order.teams || [])
    .map((t, i) => normalizeTeam(t, i))
    .find((t) => t.teamName.toLowerCase() === want);
}

function mentionOwners(slotOrTeam) {
  const ids = slotOrTeam.ownerIds
    ? slotOrTeam.ownerIds
    : ownerIds(slotOrTeam);
  if (!ids.length && slotOrTeam.discordUserId) {
    return `<@${slotOrTeam.discordUserId}>`;
  }
  return ids.map((id) => `<@${id}>`).join(' ');
}

module.exports = {
  DEFAULT_TEAM_COUNT,
  EXPECTED_TEAMS: DEFAULT_TEAM_COUNT, // backwards-compat export
  loadOrder,
  saveOrder,
  validateOrder,
  buildQueue,
  teamIndexForPick,
  applyLiveTeam,
  findTeam,
  findTeamsForUser,
  findTeamByName,
  normalizeTeam,
  resizeTeams,
  ownerIds,
  teamOwnedBy,
  slotOwnedBy,
  formatOwners,
  formatTeamLine,
  mentionOwners,
  ensureOrderFile,
};
