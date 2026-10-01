const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { pool } = require('../draft/players');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-set-pick')
    .setDescription('Admin: force-assign a player to a specific round.pick slot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((o) =>
      o.setName('round').setDescription('Round number').setRequired(true).setMinValue(1),
    )
    .addIntegerOption((o) =>
      o.setName('pick').setDescription('Pick within the round').setRequired(true).setMinValue(1),
    )
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Search player (autocomplete)')
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
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    const round = interaction.options.getInteger('round');
    const pick = interaction.options.getInteger('pick');
    const fantraxId = interaction.options.getString('player');

    try {
      const result = engine.submitPick({
        discordUserId: interaction.user.id,
        fantraxId,
        round,
        pick,
        adminOverride: true,
        source: 'admin',
      });
      const channel = await engine.getDraftChannel();
      const msg = `Admin set **${result.line}** → <@${result.pickRecord.discordUserId}>`;
      await interaction.editReply(msg);
      if (channel && channel.id !== interaction.channelId) {
        await channel.send(msg);
      } else if (channel) {
        // already replied in channel via editReply if same channel — also announce next if needed
      }
      if (result.wasCurrent && result.state.status === 'running') {
        await engine.announceOnClock(result.state);
      }
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
