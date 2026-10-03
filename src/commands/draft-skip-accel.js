const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin, loadConfig, updateConfig } = require('../config');
const { formatDuration } = require('../draft/formatDuration');

function describe(config) {
  const q = formatDuration(Math.max(1, Math.floor(config.secondsPerPick / 4)));
  const full = formatDuration(config.secondsPerPick);
  return [
    `Skip accel: **${config.skipAccelEnabled ? 'ON' : 'OFF'}** (default on)`,
    `Full clock: **${full}**. One existing open skip → **${q}**. Two or more → skip immediately.`,
    'Autodraft still runs first when the team comes up. Catch-up picks stay available.',
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-skip-accel')
    .setDescription('Short clock / auto-skip when a team already has open skips')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc.setName('status').setDescription('Show skip-accel settings'),
    )
    .addSubcommand((sc) =>
      sc.setName('enable').setDescription('Turn skip accel on (default)'),
    )
    .addSubcommand((sc) =>
      sc.setName('disable').setDescription('Turn skip accel off (always use full clock)'),
    ),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'enable') {
      const config = updateConfig({ skipAccelEnabled: true });
      await interaction.reply({ content: describe(config) });
      return;
    }
    if (sub === 'disable') {
      const config = updateConfig({ skipAccelEnabled: false });
      await interaction.reply({ content: describe(config) });
      return;
    }
    await interaction.reply({ content: describe(loadConfig()) });
  },
};
