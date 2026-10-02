const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../draft/players');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-player')
    .setDescription('Search available players and submit a pick')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Type at least 2 characters to search')
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'player') return;

    const results = pool.search(focused.value, { availableOnly: true, limit: 25 });
    await interaction.respond(
      results.map((p) => ({
        name: `${pool.formatLabel(p)}`.slice(0, 100),
        value: p.fantraxId.slice(0, 100),
      })),
    );
  },

  async execute(interaction) {
    const fantraxId = interaction.options.getString('player');
    const player = pool.get(fantraxId);

    if (!player) {
      await interaction.reply({
        content: 'Player not found. Use autocomplete to select one.',
        ephemeral: true,
      });
      return;
    }

    const state = engine.getState();
    engine.syncTeamsFromOrder(state);
    const current = engine.currentSlot(state);

    let round;
    let pick;
    const drafter = interaction.user.id;
    const target = engine.oldestOpenSlotForUser(state, drafter);
    if (target) {
      round = target.round;
      pick = target.pick;
    } else if (current) {
      round = current.round;
      pick = current.pick;
    } else {
      const config = engine.getConfig();
      round = config.startRound;
      pick = 1;
    }

    const line = pool.formatPickLine(round, pick, player);

    try {
      const result = engine.submitPick({
        discordUserId: drafter,
        fantraxId,
        round,
        pick,
        adminOverride: false,
        source: 'command',
      });

      const teamLabel =
        result.pickRecord.teamName || result.pickRecord.displayName || 'team';
      await interaction.reply(
        `Drafted: **${result.line}** → **${teamLabel}**` +
          (result.pickRecord.catchUp ? ' _(catch-up skip)_' : ''),
      );

      if (result.wasCurrent && result.state.status === 'running') {
        await engine.proceedToNextPick();
      }
    } catch (err) {
      await interaction.reply({
        content: `${err.message}\n\nFormatted pick (copy/paste when ready):\n\`${line}\``,
        ephemeral: true,
      });
    }
  },
};
