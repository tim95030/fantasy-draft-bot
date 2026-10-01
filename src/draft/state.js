const fs = require('fs');
const paths = require('../paths');

function emptyState() {
  return {
    status: 'idle', // idle | running | paused | ended
    startedAt: null,
    pausedAt: null,
    currentIndex: 0,
    clockEndsAt: null,
    sleepPaused: false,
    sleepRemainingMs: null,
    picks: [],
    skipped: [], // { round, pick, discordUserId, overallIndex, skippedAt }
    queue: [], // serialized slots
  };
}

function loadState() {
  if (!fs.existsSync(paths.STATE_JSON)) {
    const state = emptyState();
    saveState(state);
    return state;
  }
  return JSON.parse(fs.readFileSync(paths.STATE_JSON, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(paths.STATE_JSON, JSON.stringify(state, null, 2));
  return state;
}

function resetState() {
  return saveState(emptyState());
}

module.exports = {
  emptyState,
  loadState,
  saveState,
  resetState,
};
