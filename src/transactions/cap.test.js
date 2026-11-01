const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTeamCap } = require('../draft/fantrax');
const { capLines } = require('../commands/my-roster');

const payload = {
  miscData: {
    salaryInfo: {
      info: [
        { key: 'salaryUsed', value: 8.955e7 },
        { key: 'salaryRemaining', value: 1.045e7 },
        { key: 'salaryCap', value: 1.0e8 },
      ],
    },
  },
  capHitPenaltyData: {
    tableData: [
      { salaryAmount: '$850,000', scorer: { name: 'Sammy Blais' }, endingSeasonYear: 2026 },
      { salaryAmount: '$475,000', scorer: { name: 'Mason Marchment' }, endingSeasonYear: 2026 },
    ],
  },
};

test('team cap comes from Fantrax totals with dead cap listed', () => {
  const cap = parseTeamCap(payload);
  assert.deepEqual(cap, {
    used: 89_550_000,
    remaining: 10_450_000,
    cap: 100_000_000,
    deadCap: [
      { name: 'Sammy Blais', amount: 850_000, endingSeasonYear: 2026 },
      { name: 'Mason Marchment', amount: 475_000, endingSeasonYear: 2026 },
    ],
  });
  const text = capLines(cap).join('\n');
  assert.match(text, /Dead cap/);
  assert.match(text, /Sammy Blais/);
  assert.match(text, /Cap: .* used of .* space/);
});

test('missing salary info yields no cap', () => {
  assert.equal(parseTeamCap({}), null);
  assert.match(capLines(null)[0], /unavailable/);
});
