const { SlashCommandBuilder } = require('discord.js');
const { engine } = require('../draft/engine');
const { loadOrder, findTeamsForUser, normalizeTeam } = require('../draft/order');

function fantasyTeamLabel(entry) {
  if (entry.teamName) return entry.teamName;
  if (entry.displayName && entry.displayName !== entry.discordUserId) {
    return entry.displayName;
  }
  const teams = findTeamsForUser(loadOrder(), entry.discordUserId);
  if (teams.length === 1) return teams[0].teamName;
  if (Array.isArray(entry.ownerIds) && entry.ownerIds.length) {
    const order = loadOrder();
    const match = order.teams
      .map((t, i) => normalizeTeam(t, i))
      .find((t) =>
        t.owners.some((o) =>
          entry.ownerIds.map(String).includes(String(o.discordUserId)),
        ),
      );
    if (match) return match.teamName;
  }
  return null;
}

function ownedByManager(entry, managerId) {
  const id = String(managerId);
  if (String(entry.discordUserId) === id) return true;
  return Array.isArray(entry.ownerIds) && entry.ownerIds.map(String).includes(id);
}

function formatEntry(entry) {
  const fantasyTeam = fantasyTeamLabel(entry);
  const teamPart = fantasyTeam ? `**${fantasyTeam}**` : `<@${entry.discordUserId}>`;
  if (entry.kind === 'skip') {
    return `**${entry.round}.${entry.pick}** ${teamPart} — _skipped_ (open)`;
  }
  return (
    `**${entry.round}.${entry.pick}** ${teamPart} — ${entry.playerName} ${entry.position}, ${entry.team}` +
    ` (\`${entry.fantraxId}\`)`
  );
}

/** Split lines into Discord-safe message chunks (≤1900 chars). */
function chunkLines(lines, maxLen = 1900) {
  const chunks = [];
  let buf = [];
  let size = 0;
  for (const line of lines) {
    const add = line.length + (buf.length ? 1 : 0);
    if (buf.length && size + add > maxLen) {
      chunks.push(buf.join('\n'));
      buf = [line];
      size = line.length;
    } else {
      buf.push(line);
      size += add;
    }
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-board')
    .setDescription('Show picks and open skips in draft order (Rd.pick)')
    .addUserOption((o) =>
      o.setName('manager').setDescription('Filter to one manager / team owner'),
    )
    .addIntegerOption((o) =>
      o
        .setName('limit')
        .setDescription('Max slots to show from the end (default: all, max 200)')
        .setMinValue(1)
        .setMaxValue(200),
    ),

  async execute(interaction) {
    const manager = interaction.options.getUser('manager');
    const limitOpt = interaction.options.getInteger('limit');
    const state = engine.getState();
    engine.syncTeamsFromOrder(state);

    const filledKeys = new Set(state.picks.map((p) => `${p.round}.${p.pick}`));

    let entries = [
      ...state.picks.map((p) => ({ ...p, kind: 'pick' })),
      ...state.skipped
        .filter((s) => !filledKeys.has(`${s.round}.${s.pick}`))
        .map((s) => ({ ...s, kind: 'skip' })),
    ];

    if (manager) {
      entries = entries.filter((e) => ownedByManager(e, manager.id));
    }

    entries.sort((a, b) => a.round - b.round || a.pick - b.pick);
    const total = entries.length;
    if (limitOpt != null) {
      entries = entries.slice(-limitOpt);
    }

    if (!entries.length) {
      await interaction.reply({
        content: 'No picks or open skips yet.',
        ephemeral: true,
      });
      return;
    }

    const header =
      entries.length < total
        ? `_Showing last **${entries.length}** of **${total}** slots_\n`
        : `_**${total}** slots_\n`;
    const lines = entries.map(formatEntry);
    const chunks = chunkLines([header.trimEnd(), ...lines]);

    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (let i = 1; i < chunks.length; i += 1) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
  },
};
