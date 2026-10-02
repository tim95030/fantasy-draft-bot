const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../draft/players');
const playerQueue = require('../draft/playerQueue');
const {
  loadOrder,
  normalizeTeam,
  teamOwnedBy,
} = require('../draft/order');

function searchTeams(query, limit = 25) {
  const order = loadOrder();
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const scored = [];
  order.teams.forEach((raw, i) => {
    const team = normalizeTeam(raw, i);
    const name = team.teamName.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 50;
    else if (String(i + 1) === q || `slot ${i + 1}`.includes(q)) score = 40;
    else return;
    scored.push({ score, i, team });
  });
  scored.sort(
    (a, b) => b.score - a.score || a.team.teamName.localeCompare(b.team.teamName),
  );
  return scored.slice(0, limit);
}

function resolveTeamFromOption(value) {
  const order = loadOrder();
  const m = String(value || '').match(/^slot:(\d+)$/i);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= order.teams.length) return null;
    return { index: idx, team: normalizeTeam(order.teams[idx], idx) };
  }
  const want = String(value || '')
    .trim()
    .toLowerCase();
  let idx = order.teams.findIndex(
    (t, i) => normalizeTeam(t, i).teamName.toLowerCase() === want,
  );
  if (idx < 0 && want) {
    const hits = order.teams
      .map((t, i) => ({ i, name: normalizeTeam(t, i).teamName.toLowerCase() }))
      .filter(({ name }) => name.includes(want) || want.includes(name));
    if (hits.length === 1) idx = hits[0].i;
  }
  if (idx < 0) return null;
  return { index: idx, team: normalizeTeam(order.teams[idx], idx) };
}

function ownedTeamChoices(userId) {
  const order = loadOrder();
  return (order.teams || [])
    .map((raw, i) => ({ index: i, team: normalizeTeam(raw, i) }))
    .filter(({ team }) => teamOwnedBy(team, userId));
}

/**
 * Resolve which fantasy team the user is managing for this command.
 */
function resolveTargetTeam(userId, forTeamValue) {
  const owned = ownedTeamChoices(userId);
  if (!owned.length) {
    return { error: 'You are not an owner of any draft team.' };
  }

  if (forTeamValue) {
    const resolved = resolveTeamFromOption(forTeamValue);
    if (!resolved) return { error: 'Team not found. Use autocomplete to pick your team.' };
    if (!teamOwnedBy(resolved.team, userId)) {
      return { error: 'You can only manage the queue for a team you own.' };
    }
    return resolved;
  }

  if (owned.length === 1) return owned[0];

  return {
    error:
      `You own **${owned.length}** teams. Pass \`for_team\` (autocomplete) to choose one:\n` +
      owned
        .slice(0, 15)
        .map(({ index, team }) => `• ${team.teamName} (#${index + 1})`)
        .join('\n'),
  };
}

function formatQueueList(teamIndex, teamName) {
  const entry = playerQueue.getEntry(teamIndex);
  const lines = entry.fantraxIds.map((id, i) => {
    const p = pool.get(id);
    if (!p) return `**${i + 1}.** \`${id}\` _(missing)_`;
    const flag = p.taken ? ' _(taken)_' : '';
    return `**${i + 1}.** ${pool.formatLabel(p)}${flag}`;
  });
  const body =
    lines.length === 0
      ? '_Empty — add players with `/draft-queue add`._'
      : lines.join('\n');
  return [
    `**${teamName}** queue · autodraft **${entry.autoDraft ? 'ON' : 'OFF'}** (${entry.fantraxIds.length}/${playerQueue.MAX_QUEUE})`,
    body,
  ].join('\n');
}

function forTeamOption(option) {
  return option
    .setName('for_team')
    .setDescription('Your fantasy team (required if you own more than one)')
    .setAutocomplete(true);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-queue')
    .setDescription('Manage your team’s autodraft queue')
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Add a player to the end of your queue')
        .addStringOption((o) =>
          o
            .setName('player')
            .setDescription('Type at least 2 characters to search')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption(forTeamOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName('remove')
        .setDescription('Remove a player from your queue by position')
        .addIntegerOption((o) =>
          o
            .setName('position')
            .setDescription('1-based position in your queue')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(playerQueue.MAX_QUEUE),
        )
        .addStringOption(forTeamOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName('move')
        .setDescription('Reorder: move a queue slot to a new position')
        .addIntegerOption((o) =>
          o
            .setName('from')
            .setDescription('Current 1-based position')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(playerQueue.MAX_QUEUE),
        )
        .addIntegerOption((o) =>
          o
            .setName('to')
            .setDescription('New 1-based position')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(playerQueue.MAX_QUEUE),
        )
        .addStringOption(forTeamOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName('clear')
        .setDescription('Remove all players from your queue')
        .addStringOption(forTeamOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName('show')
        .setDescription('Show your queue and autodraft status')
        .addStringOption(forTeamOption),
    )
    .addSubcommand((sc) =>
      sc
        .setName('autodraft')
        .setDescription('Turn autodraft on or off for your team')
        .addBooleanOption((o) =>
          o
            .setName('enabled')
            .setDescription('When on, drafts your #1 available queued player on your turn')
            .setRequired(true),
        )
        .addStringOption(forTeamOption),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'player') {
      const results = pool.search(focused.value, { availableOnly: true, limit: 25 });
      await interaction.respond(
        results.map((p) => ({
          name: `${pool.formatLabel(p)}`.slice(0, 100),
          value: p.fantraxId.slice(0, 100),
        })),
      );
      return;
    }

    if (focused.name === 'for_team') {
      const owned = ownedTeamChoices(interaction.user.id);
      const q = String(focused.value || '')
        .trim()
        .toLowerCase();
      const list = (owned.length ? owned : searchTeams(focused.value, 25).map((r) => ({
        index: r.i,
        team: r.team,
      }))).filter(({ team }) => {
        if (!q) return true;
        return team.teamName.toLowerCase().includes(q);
      });
      await interaction.respond(
        list.slice(0, 25).map(({ index, team }) => ({
          name: `${team.teamName} (#${index + 1})`.slice(0, 100),
          value: `slot:${index + 1}`,
        })),
      );
    }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const forTeamValue = interaction.options.getString('for_team');
    const target = resolveTargetTeam(interaction.user.id, forTeamValue);
    if (target.error) {
      await interaction.reply({ content: target.error, ephemeral: true });
      return;
    }

    const { index, team } = target;

    try {
      if (sub === 'show') {
        await interaction.reply({
          content: formatQueueList(index, team.teamName),
          ephemeral: true,
        });
        return;
      }

      if (sub === 'add') {
        const fantraxId = interaction.options.getString('player');
        const player = pool.get(fantraxId);
        if (!player) {
          await interaction.reply({
            content: 'Player not found. Use autocomplete to select one.',
            ephemeral: true,
          });
          return;
        }
        if (player.taken) {
          await interaction.reply({
            content: `**${player.name}** is already drafted.`,
            ephemeral: true,
          });
          return;
        }
        playerQueue.addPlayer(index, fantraxId, { by: interaction.user.id });
        await interaction.reply({
          content: `Added **${pool.formatLabel(player)}** to **${team.teamName}** queue.\n\n${formatQueueList(index, team.teamName)}`,
          ephemeral: true,
        });
        return;
      }

      if (sub === 'remove') {
        const position = interaction.options.getInteger('position');
        const removedId = playerQueue.removeAt(index, position, {
          by: interaction.user.id,
        });
        const p = pool.get(removedId);
        const label = p ? pool.formatLabel(p) : removedId;
        await interaction.reply({
          content: `Removed **${label}** from **${team.teamName}** queue.\n\n${formatQueueList(index, team.teamName)}`,
          ephemeral: true,
        });
        return;
      }

      if (sub === 'move') {
        const from = interaction.options.getInteger('from');
        const to = interaction.options.getInteger('to');
        playerQueue.move(index, from, to, { by: interaction.user.id });
        await interaction.reply({
          content: `Moved #${from} → #${to} for **${team.teamName}**.\n\n${formatQueueList(index, team.teamName)}`,
          ephemeral: true,
        });
        return;
      }

      if (sub === 'clear') {
        playerQueue.clear(index, { by: interaction.user.id });
        await interaction.reply({
          content: `Cleared **${team.teamName}** queue.\n\n${formatQueueList(index, team.teamName)}`,
          ephemeral: true,
        });
        return;
      }

      if (sub === 'autodraft') {
        const enabled = interaction.options.getBoolean('enabled');
        playerQueue.setAutoDraft(index, enabled, { by: interaction.user.id });
        const entry = playerQueue.getEntry(index);
        await interaction.reply({
          content:
            `Autodraft **${enabled ? 'ON' : 'OFF'}** for **${team.teamName}**.` +
            (enabled && !entry.fantraxIds.length
              ? '\n_Queue is empty — add players with `/draft-queue add`._'
              : '') +
            `\n\n${formatQueueList(index, team.teamName)}`,
          ephemeral: true,
        });
      }
    } catch (err) {
      await interaction.reply({
        content: err.message || String(err),
        ephemeral: true,
      });
    }
  },
};
