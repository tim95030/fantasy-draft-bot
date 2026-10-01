const fs = require('fs');
const paths = require('../paths');

const EXPECTED_TEAMS = 32;

function ensureOrderFile() {
  if (!fs.existsSync(paths.ORDER_JSON)) {
    if (fs.existsSync(paths.ORDER_SAMPLE)) {
      fs.copyFileSync(paths.ORDER_SAMPLE, paths.ORDER_JSON);
    } else {
      fs.writeFileSync(
        paths.ORDER_JSON,
        JSON.stringify({ snake: true, teams: [] }, null, 2),
      );
    }
  }
}

function loadOrder() {
  ensureOrderFile();
  const raw = JSON.parse(fs.readFileSync(paths.ORDER_JSON, 'utf8'));
  return {
    snake: Boolean(raw.snake),
    teams: Array.isArray(raw.teams) ? raw.teams : [],
  };
}

function saveOrder(order) {
  fs.writeFileSync(paths.ORDER_JSON, JSON.stringify(order, null, 2));
  return order;
}

function validateOrder(order) {
  const teams = order.teams || [];
  if (teams.length !== EXPECTED_TEAMS) {
    return `Draft order must have exactly ${EXPECTED_TEAMS} teams (found ${teams.length}).`;
  }
  const seen = new Set();
  for (let i = 0; i < teams.length; i += 1) {
    const t = teams[i];
    if (!t.discordUserId) return `Team #${i + 1} missing discordUserId`;
    if (seen.has(String(t.discordUserId))) {
      return `Duplicate discordUserId at slot #${i + 1}`;
    }
    seen.add(String(t.discordUserId));
  }
  return null;
}

/**
 * Build the full pick queue for the active draft window.
 * Round numbering uses absolute rounds starting at startRound.
 * Within each round, pick is 1..N (slot in that round's order).
 * Snake: odd offset from startRound uses forward order; even offset reverses.
 */
function buildQueue({ teams, snake, startRound, totalRounds }) {
  const queue = [];
  const n = teams.length;
  for (let r = 0; r < totalRounds; r += 1) {
    const round = startRound + r;
    const reverse = snake && r % 2 === 1;
    const order = reverse ? [...teams].reverse() : teams;
    for (let i = 0; i < n; i += 1) {
      const team = order[i];
      queue.push({
        round,
        pick: i + 1,
        discordUserId: String(team.discordUserId),
        displayName: team.displayName || `Team ${i + 1}`,
        overallIndex: queue.length,
      });
    }
  }
  return queue;
}

function findTeam(order, discordUserId) {
  return order.teams.find((t) => String(t.discordUserId) === String(discordUserId));
}

function slotIndexInRound(order, discordUserId, round, startRound, snake) {
  const offset = round - startRound;
  const reverse = snake && offset % 2 === 1;
  const teams = reverse ? [...order.teams].reverse() : order.teams;
  const idx = teams.findIndex((t) => String(t.discordUserId) === String(discordUserId));
  return idx < 0 ? null : idx + 1;
}

module.exports = {
  EXPECTED_TEAMS,
  loadOrder,
  saveOrder,
  validateOrder,
  buildQueue,
  findTeam,
  slotIndexInRound,
  ensureOrderFile,
};
