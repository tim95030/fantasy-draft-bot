const fs = require('fs');
const paths = require('../paths');

/**
 * Minimal CSV parser that handles quoted fields and commas inside quotes.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // ignore
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell == null ? '' : String(cell);
          if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(','),
    )
    .join('\n');
}

function normalize(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function truthy(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

class PlayerPool {
  constructor() {
    /** @type {Map<string, object>} */
    this.byId = new Map();
    /** @type {Map<string, string[]>} identity key -> fantraxIds */
    this.byIdentity = new Map();
  }

  clear() {
    this.byId.clear();
    this.byIdentity.clear();
  }

  identityKey(name, position, team) {
    return `${normalize(name)}|${normalize(position)}|${normalize(team)}`;
  }

  add(player) {
    const fantraxId = String(player.fantraxId).trim();
    if (!fantraxId) throw new Error('Player missing fantraxId');
    const entry = {
      fantraxId,
      name: String(player.name || '').trim(),
      position: String(player.position || '').trim().toUpperCase(),
      team: String(player.team || '').trim().toUpperCase(),
      taken: Boolean(player.taken),
    };
    this.byId.set(fantraxId, entry);
    const key = this.identityKey(entry.name, entry.position, entry.team);
    const list = this.byIdentity.get(key) || [];
    if (!list.includes(fantraxId)) list.push(fantraxId);
    this.byIdentity.set(key, list);
    return entry;
  }

  loadFromCsvText(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('CSV is empty');

    const header = rows[0].map((h) => normalize(h).replace(/\s+/g, ''));
    const idx = {
      fantraxId: header.findIndex((h) => ['fantraxid', 'id', 'player_id'].includes(h)),
      name: header.findIndex((h) => ['name', 'player', 'playername'].includes(h)),
      position: header.findIndex((h) => ['position', 'pos'].includes(h)),
      team: header.findIndex((h) => ['team', 'nhlteam', 'realteam'].includes(h)),
      taken: header.findIndex((h) => ['taken', 'drafted', 'owned'].includes(h)),
    };

    if (idx.fantraxId < 0 || idx.name < 0 || idx.position < 0 || idx.team < 0) {
      throw new Error('CSV must include columns: fantraxId, name, position, team (, taken)');
    }

    this.clear();
    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i];
      this.add({
        fantraxId: r[idx.fantraxId],
        name: r[idx.name],
        position: r[idx.position],
        team: r[idx.team],
        taken: idx.taken >= 0 ? truthy(r[idx.taken]) : false,
      });
    }
    return this.size;
  }

  loadFromFile(filePath = paths.PLAYERS_CSV) {
    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(paths.PLAYERS_SAMPLE)) {
        fs.copyFileSync(paths.PLAYERS_SAMPLE, paths.PLAYERS_CSV);
      } else {
        throw new Error(`Missing players file: ${filePath}`);
      }
    }
    return this.loadFromCsvText(fs.readFileSync(filePath, 'utf8'));
  }

  saveToFile(filePath = paths.PLAYERS_CSV) {
    const rows = [['fantraxId', 'name', 'position', 'team', 'taken']];
    for (const p of this.byId.values()) {
      rows.push([p.fantraxId, p.name, p.position, p.team, p.taken ? 'true' : 'false']);
    }
    fs.writeFileSync(filePath, `${toCsv(rows)}\n`);
  }

  get size() {
    return this.byId.size;
  }

  get(fantraxId) {
    return this.byId.get(String(fantraxId));
  }

  markTaken(fantraxId, taken = true) {
    const p = this.get(fantraxId);
    if (!p) return null;
    p.taken = taken;
    return p;
  }

  available() {
    return [...this.byId.values()].filter((p) => !p.taken);
  }

  resolveByIdentity(name, position, team) {
    const key = this.identityKey(name, position, team);
    const ids = this.byIdentity.get(key) || [];
    const players = ids.map((id) => this.get(id)).filter(Boolean);
    return players;
  }

  findByName(name) {
    const n = normalize(name);
    return [...this.byId.values()].filter((p) => normalize(p.name) === n);
  }

  /**
   * Ranked search for autocomplete. Requires query length >= 2.
   */
  search(query, { availableOnly = true, limit = 25 } = {}) {
    const q = normalize(query);
    if (q.length < 2) return [];

    const pool = availableOnly ? this.available() : [...this.byId.values()];
    const scored = [];

    for (const p of pool) {
      const name = normalize(p.name);
      const pos = normalize(p.position);
      const team = normalize(p.team);
      const id = normalize(p.fantraxId);
      const last = name.split(' ').pop() || '';

      let score = 0;
      if (id === q) score = 1000;
      else if (id.startsWith(q)) score = 900;
      else if (name.startsWith(q)) score = 800;
      else if (last.startsWith(q)) score = 750;
      else if (name.includes(q)) score = 600;
      else if (team === q || team.startsWith(q)) score = 500;
      else if (pos === q) score = 400;
      else if (`${name} ${pos} ${team}`.includes(q)) score = 300;
      else continue;

      scored.push({ score, player: p });
    }

    scored.sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name));
    return scored.slice(0, limit).map((s) => s.player);
  }

  formatLabel(player) {
    return `${player.name} — ${player.position}, ${player.team}`;
  }

  formatPickLine(round, pick, player) {
    return `${round}.${pick} ${player.name} ${player.position}, ${player.team}`;
  }
}

const pool = new PlayerPool();

module.exports = {
  PlayerPool,
  pool,
  parseCsv,
  toCsv,
  normalize,
};
