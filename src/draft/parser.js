/**
 * Pick message format: `{round}.{pick} {Player Name} {POS}, {TEAM}`
 * Example: `32.5 John Doe LW, ANA`
 */

const PICK_RE =
  /^\s*(\d+)\.(\d+)\s+(.+?)\s+([A-Za-z0-9/+-]+)\s*,\s*([A-Za-z0-9]+)\s*$/;

function parsePickMessage(content) {
  const text = String(content || '').trim();
  // Only consider single-line pick posts (ignore multi-line chatter)
  const firstLine = text.split(/\r?\n/)[0].trim();
  const m = firstLine.match(PICK_RE);
  if (!m) return null;

  return {
    round: Number(m[1]),
    pick: Number(m[2]),
    playerName: m[3].trim(),
    position: m[4].trim().toUpperCase(),
    team: m[5].trim().toUpperCase(),
    raw: firstLine,
  };
}

function formatPickLine(round, pick, name, position, team) {
  return `${round}.${pick} ${name} ${String(position).toUpperCase()}, ${String(team).toUpperCase()}`;
}

if (require.main === module) {
  const samples = [
    '32.5 John Doe LW, ANA',
    '3.5 John Doe LW, ANA',
    '  10.12  Jane Smith  RW , TOR ',
    'not a pick',
    '32.5 Only Name',
  ];
  for (const s of samples) {
    console.log(JSON.stringify({ input: s, parsed: parsePickMessage(s) }));
  }
}

module.exports = {
  PICK_RE,
  parsePickMessage,
  formatPickLine,
};
