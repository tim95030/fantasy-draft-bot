const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

module.exports = {
  ROOT,
  DATA,
  PLAYERS_CSV: path.join(DATA, 'players.csv'),
  PLAYERS_DEFAULT: path.join(DATA, 'players.default.csv'),
  PLAYERS_SAMPLE: path.join(DATA, 'players.sample.csv'),
  ORDER_JSON: path.join(DATA, 'draft-order.json'),
  ORDER_SAMPLE: path.join(DATA, 'draft-order.sample.json'),
  CONFIG_JSON: path.join(DATA, 'config.json'),
  CONFIG_SAMPLE: path.join(DATA, 'config.sample.json'),
  STATE_JSON: path.join(DATA, 'draft-state.json'),
  PRESET_CSV: path.join(DATA, 'preset-picks.csv'),
  PRESET_SAMPLE: path.join(DATA, 'preset-picks.sample.csv'),
  PLAYER_QUEUES_JSON: path.join(DATA, 'player-queues.json'),
};
