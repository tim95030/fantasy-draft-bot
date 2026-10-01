const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { updateConfig, isAdmin } = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-setup')
    .setDescription('Configure draft channel, rounds, timer, snake, and admins')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Draft channel').setRequired(false),
    )
    .addIntegerOption((o) =>
      o.setName('start_round').setDescription('First round to run (e.g. 32)').setMinValue(1),
    )
    .addIntegerOption((o) =>
      o
        .setName('total_rounds')
        .setDescription('How many rounds remain from start_round')
        .setMinValue(1),
    )
    .addIntegerOption((o) =>
      o
        .setName('seconds_per_pick')
        .setDescription('Pick clock in seconds')
        .setMinValue(5),
    )
    .addBooleanOption((o) =>
      o.setName('snake').setDescription('Use snake draft order'),
    )
    .addUserOption((o) =>
      o.setName('add_admin').setDescription('Add a draft admin'),
    )
    .addUserOption((o) =>
      o.setName('remove_admin').setDescription('Remove a draft admin'),
    ),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    const channel = interaction.options.getChannel('channel');
    const startRound = interaction.options.getInteger('start_round');
    const totalRounds = interaction.options.getInteger('total_rounds');
    const seconds = interaction.options.getInteger('seconds_per_pick');
    const snake = interaction.options.getBoolean('snake');
    const addAdmin = interaction.options.getUser('add_admin');
    const removeAdmin = interaction.options.getUser('remove_admin');

    const partial = { guildId: interaction.guildId };
    if (channel) partial.draftChannelId = channel.id;
    if (startRound != null) partial.startRound = startRound;
    if (totalRounds != null) partial.totalRounds = totalRounds;
    if (seconds != null) partial.secondsPerPick = seconds;
    if (snake != null) partial.snake = snake;

    const { loadConfig } = require('../config');
    const current = loadConfig();
    let adminUserIds = [...(current.adminUserIds || [])].map(String);
    if (!adminUserIds.includes(String(interaction.user.id))) {
      adminUserIds.push(String(interaction.user.id));
    }
    if (addAdmin) {
      const id = String(addAdmin.id);
      if (!adminUserIds.includes(id)) adminUserIds.push(id);
    }
    if (removeAdmin) {
      adminUserIds = adminUserIds.filter((id) => id !== String(removeAdmin.id));
    }
    partial.adminUserIds = adminUserIds;

    const config = updateConfig(partial);
    await interaction.reply({
      content: [
        'Draft config saved:',
        `• Channel: ${config.draftChannelId ? `<#${config.draftChannelId}>` : '_unset_'}`,
        `• Start round: **${config.startRound}**`,
        `• Total rounds: **${config.totalRounds}**`,
        `• Seconds/pick: **${config.secondsPerPick}**`,
        `• Snake: **${config.snake}**`,
        `• Admins: ${config.adminUserIds.map((id) => `<@${id}>`).join(', ') || '_none_'}`,
      ].join('\n'),
      ephemeral: true,
    });
  },
};
