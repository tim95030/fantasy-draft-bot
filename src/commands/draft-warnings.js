const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  isAdmin,
  loadConfig,
  updateConfig,
  normalizePickWarnings,
} = require('../config');
const { formatDuration } = require('../draft/formatDuration');
const { engine } = require('../draft/engine');

function formatWarningList(warnings, secondsPerPick) {
  if (!warnings.length) {
    return `_None configured._ Pick clock is **${formatDuration(secondsPerPick)}**.`;
  }
  return (
    warnings.map((s, i) => `**${i + 1}.** ${formatDuration(s)} remaining`).join('\n') +
    `\n\nPick clock: **${formatDuration(secondsPerPick)}**`
  );
}

/** Refresh warning timers only — never resets the pick expire deadline. */
function refreshWarningsIfRunning() {
  return engine.refreshWarnings();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-warnings')
    .setDescription('Admin: pick-clock warnings (re-announce who is up as time runs out)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Warn when this many seconds remain (must be < pick clock)')
        .addIntegerOption((o) =>
          o
            .setName('seconds')
            .setDescription('Seconds remaining when to warn (e.g. 60, 30, 10)')
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName('list').setDescription('List configured warning thresholds'),
    )
    .addSubcommand((sc) =>
      sc
        .setName('remove')
        .setDescription('Remove a warning threshold')
        .addIntegerOption((o) =>
          o
            .setName('seconds')
            .setDescription('Exact seconds-remaining value to remove')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName('clear').setDescription('Remove all warning thresholds'),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'seconds') return;
    const config = loadConfig();
    const q = String(focused.value || '').trim();
    const choices = (config.pickWarningsSec || [])
      .filter((s) => !q || String(s).startsWith(q))
      .slice(0, 25)
      .map((s) => ({
        name: `${formatDuration(s)} remaining`,
        value: s,
      }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const config = loadConfig();
    const clock = config.secondsPerPick;

    if (sub === 'list') {
      await interaction.reply({
        content: `**Pick warnings**\n${formatWarningList(config.pickWarningsSec || [], clock)}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'clear') {
      updateConfig({ pickWarningsSec: [] });
      refreshWarningsIfRunning();
      await interaction.reply({
        content: 'Cleared all pick warnings.',
        ephemeral: true,
      });
      return;
    }

    if (sub === 'add') {
      const seconds = interaction.options.getInteger('seconds');
      if (seconds >= clock) {
        await interaction.reply({
          content:
            `Warning must be **less than** the pick clock (**${formatDuration(clock)}** / ${clock}s). ` +
            `Got ${seconds}s.`,
          ephemeral: true,
        });
        return;
      }
      const existing = config.pickWarningsSec || [];
      if (existing.includes(seconds)) {
        await interaction.reply({
          content: `Already warning at **${formatDuration(seconds)}** remaining.`,
          ephemeral: true,
        });
        return;
      }
      const next = normalizePickWarnings([...existing, seconds], clock);
      updateConfig({ pickWarningsSec: next });
      refreshWarningsIfRunning();
      await interaction.reply({
        content:
          `Added warning at **${formatDuration(seconds)}** remaining.\n` +
          formatWarningList(next, clock),
        ephemeral: true,
      });
      return;
    }

    if (sub === 'remove') {
      const seconds = interaction.options.getInteger('seconds');
      const existing = config.pickWarningsSec || [];
      if (!existing.includes(seconds)) {
        await interaction.reply({
          content:
            `No warning at **${seconds}s**. Current:\n` +
            formatWarningList(existing, clock),
          ephemeral: true,
        });
        return;
      }
      const next = existing.filter((s) => s !== seconds);
      updateConfig({ pickWarningsSec: next });
      refreshWarningsIfRunning();
      await interaction.reply({
        content:
          `Removed warning at **${formatDuration(seconds)}** remaining.\n` +
          formatWarningList(next, clock),
        ephemeral: true,
      });
    }
  },
};
