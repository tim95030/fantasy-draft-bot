const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-skip')
    .setDescription('Force-skip the current pick')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const { slot, state } = engine.forceSkip();
      const next = engine.currentSlot(state);
      await interaction.editReply(
        `Skipped **${slot.round}.${slot.pick}** <@${slot.discordUserId}>.` +
          (next
            ? ` Now on the clock: **${next.round}.${next.pick}** <@${next.discordUserId}>`
            : ' Draft queue finished.'),
      );
      if (state.status === 'running' && next) await engine.announceOnClock(state);
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
