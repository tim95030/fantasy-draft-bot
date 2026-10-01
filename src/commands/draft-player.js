const { SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { pool } = require('../draft/players');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-player')
    .setDescription('Search available players and submit (or format) a pick')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Type at least 2 characters to search')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addUserOption((o) =>
      o
        .setName('for_manager')
        .setDescription('Admin only: submit this pick on behalf of a manager'),
    )
    .addBooleanOption((o) =>
      o
        .setName('post_only')
        .setDescription('Only post the formatted pick line (do not auto-submit)'),
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
    const forManager = interaction.options.getUser('for_manager');
    const postOnly = interaction.options.getBoolean('post_only') || false;
    const player = pool.get(fantraxId);

    if (!player) {
      await interaction.reply({
        content: 'Player not found. Use autocomplete to select one.',
        ephemeral: true,
      });
      return;
    }

    if (forManager && !isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({
        content: 'Only admins can draft for another manager.',
        ephemeral: true,
      });
      return;
    }

    const state = engine.getState();
    const drafterId = forManager ? forManager.id : interaction.user.id;
    const current = engine.currentSlot(state);
    const openSkip = engine.openSkipsForUser(state, drafterId)[0];

    let round;
    let pick;
    if (
      current &&
      String(current.discordUserId) === String(drafterId) &&
      !engine.isFilled(state, current.round, current.pick)
    ) {
      round = current.round;
      pick = current.pick;
    } else if (openSkip) {
      round = openSkip.round;
      pick = openSkip.pick;
    } else if (current) {
      round = current.round;
      pick = current.pick;
    } else {
      const config = engine.getConfig();
      round = config.startRound;
      pick = 1;
    }

    const line = pool.formatPickLine(round, pick, player);

    if (postOnly) {
      await interaction.reply(line);
      return;
    }

    try {
      const result = engine.submitPick({
        discordUserId: drafterId,
        fantraxId,
        round,
        pick,
        adminOverride:
          Boolean(forManager) && isAdmin(interaction.user.id, interaction.member),
        source: 'command',
      });

      await interaction.reply(
        `Drafted: **${result.line}** → <@${result.pickRecord.discordUserId}>` +
          (result.pickRecord.catchUp ? ' _(catch-up skip)_' : ''),
      );

      if (result.wasCurrent && result.state.status === 'running') {
        await engine.announceOnClock(result.state);
      }
    } catch (err) {
      await interaction.reply({
        content: `${err.message}\n\nFormatted pick (copy/paste when ready):\n\`${line}\``,
        ephemeral: true,
      });
    }
  },
};
