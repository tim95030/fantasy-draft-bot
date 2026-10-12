const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-makeup')
    .setDescription('Make-up window for skipped picks after the last round')
    .addSubcommand((sc) =>
      sc.setName('status').setDescription('Show time left and every open skipped pick'),
    )
    .addSubcommand((sc) =>
      sc
        .setName('start')
        .setDescription('Admin: open the make-up window now (after the draft ended)')
        .addIntegerOption((o) =>
          o
            .setName('hours')
            .setDescription('Window length (defaults to /draft-setup makeup_hours)')
            .setMinValue(1)
            .setMaxValue(336),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName('end').setDescription('Admin: close the make-up window now'),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const state = engine.getState();

    if (sub === 'status') {
      if (state.status !== 'makeup') {
        await interaction.reply({
          content: `No make-up window is open (draft status: **${state.status}**).`,
          ephemeral: true,
        });
        return;
      }
      engine.syncTeamsFromOrder(state);
      const [first, ...rest] = engine.makeupMessages(state, 'status');
      const silent = { parse: [] };
      await interaction.reply({ content: first, ephemeral: true, allowedMentions: silent });
      for (const content of rest) {
        await interaction.followUp({ content, ephemeral: true, allowedMentions: silent });
      }
      return;
    }

    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    if (sub === 'end') {
      if (state.status !== 'makeup') {
        await interaction.reply({ content: 'No make-up window is open.', ephemeral: true });
        return;
      }
      await interaction.reply({ content: 'Closing the make-up window.', ephemeral: true });
      await engine.finishMakeup('admin');
      return;
    }

    if (state.status === 'makeup') {
      await interaction.reply({
        content:
          'The make-up window is already open. Change its length with `/draft-setup makeup_hours`.',
        ephemeral: true,
      });
      return;
    }
    if (state.status !== 'ended') {
      await interaction.reply({
        content: `Make-up opens automatically after the last round (draft status: **${state.status}**).`,
        ephemeral: true,
      });
      return;
    }
    if (!engine.openSkips(state).length) {
      await interaction.reply({ content: 'There are no open skipped picks.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const hours = interaction.options.getInteger('hours');
      const next = await engine.enterMakeup(state, { hours });
      await interaction.editReply(
        `Make-up window open until <t:${Math.floor(next.makeupEndsAt / 1000)}:F>.`,
      );
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
