const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin, loadConfig, updateConfig } = require('../config');
const { engine } = require('../draft/engine');
const {
  parseHm,
  isValidTimeZone,
  isInSleepWindow,
  sleepWindowLabel,
  nextSleepEndDate,
  formatInZone,
} = require('../draft/sleepHours');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-sleep')
    .setDescription('Configure overnight sleep hours (timer pauses; picks still allowed)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc.setName('status').setDescription('Show current sleep-hours settings'),
    )
    .addSubcommand((sc) =>
      sc
        .setName('set')
        .setDescription('Set sleep window start/end and timezone')
        .addStringOption((o) =>
          o
            .setName('start')
            .setDescription('Sleep starts at HH:MM (24h), e.g. 22:00')
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('end')
            .setDescription('Sleep ends at HH:MM (24h), e.g. 08:00')
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('timezone')
            .setDescription('IANA timezone, e.g. America/Los_Angeles')
            .setRequired(true),
        )
        .addBooleanOption((o) =>
          o
            .setName('enabled')
            .setDescription('Turn sleep hours on (default true when setting)'),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('enable')
        .setDescription('Turn sleep hours on (uses saved start/end/timezone)'),
    )
    .addSubcommand((sc) =>
      sc.setName('disable').setDescription('Turn sleep hours off'),
    ),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const config = loadConfig();

    if (sub === 'status') {
      const sleeping = isInSleepWindow(config);
      const wake = sleeping ? nextSleepEndDate(config) : null;
      await interaction.reply({
        content: [
          `Sleep enabled: **${config.sleepEnabled}**`,
          `Window: **${sleepWindowLabel(config)}**`,
          `Currently sleeping: **${sleeping}**`,
          wake
            ? `Resumes: **${formatInZone(wake, config.sleepTimezone || 'America/Los_Angeles')}**`
            : null,
          'During sleep the pick **timer** pauses; managers can still make picks.',
        ]
          .filter(Boolean)
          .join('\n'),
        ephemeral: true,
      });
      return;
    }

    if (sub === 'disable') {
      updateConfig({ sleepEnabled: false });
      await engine.checkSleepTransition();
      await interaction.reply({
        content: 'Sleep hours **disabled**. Timer runs 24/7 while the draft is active.',
        ephemeral: true,
      });
      return;
    }

    if (sub === 'enable') {
      if (parseHm(config.sleepStart) == null || parseHm(config.sleepEnd) == null) {
        await interaction.reply({
          content: 'Set a window first with `/draft-sleep set`.',
          ephemeral: true,
        });
        return;
      }
      updateConfig({ sleepEnabled: true });
      await engine.checkSleepTransition();
      await interaction.reply({
        content: `Sleep hours **enabled**: ${sleepWindowLabel({ ...config, sleepEnabled: true })}`,
        ephemeral: true,
      });
      return;
    }

    // set
    const start = interaction.options.getString('start');
    const end = interaction.options.getString('end');
    const timezone = interaction.options.getString('timezone');
    const enabledOpt = interaction.options.getBoolean('enabled');

    if (parseHm(start) == null || parseHm(end) == null) {
      await interaction.reply({
        content: 'Times must be `HH:MM` 24-hour format (e.g. `22:00` and `08:00`).',
        ephemeral: true,
      });
      return;
    }
    if (!isValidTimeZone(timezone)) {
      await interaction.reply({
        content: `Invalid timezone \`${timezone}\`. Use an IANA name like \`America/Los_Angeles\`, \`America/New_York\`, \`America/Chicago\`.`,
        ephemeral: true,
      });
      return;
    }
    if (parseHm(start) === parseHm(end)) {
      await interaction.reply({
        content: 'Start and end cannot be the same time.',
        ephemeral: true,
      });
      return;
    }

    const next = updateConfig({
      sleepStart: start,
      sleepEnd: end,
      sleepTimezone: timezone,
      sleepEnabled: enabledOpt != null ? enabledOpt : true,
    });

    await engine.checkSleepTransition();

    await interaction.reply({
      content: [
        'Sleep hours saved:',
        `• Enabled: **${next.sleepEnabled}**`,
        `• Window: **${sleepWindowLabel(next)}**`,
        `• Example: timer pauses at ${next.sleepStart} and resumes at ${next.sleepEnd} (${next.sleepTimezone})`,
        'Picks remain allowed during sleep; only the countdown pauses.',
      ].join('\n'),
      ephemeral: true,
    });
  },
};
