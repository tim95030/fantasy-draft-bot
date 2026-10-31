const CALLUP_CONTRACT = 'First (6-year rookie deal, 850k this season)';

/** Error text if this Fantrax roster item can't be called up, else null. */
function callupError(item, playerName) {
  if (!item) return `${playerName} isn't on your Fantrax roster.`;
  if (String(item.contract || '').toLowerCase() !== 'minors') {
    return `${playerName} is already on a pro contract (**${item.contract || 'unknown'}**). Callups are permanent.`;
  }
  return null;
}

module.exports = { CALLUP_CONTRACT, callupError };
