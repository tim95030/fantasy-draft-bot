const { SlashCommandBuilder } = require('discord.js');
const { isTxnCommish } = require('../config');
const settings = require('../lineup/settings');
const { tracker } = require('../lineup');
const { report } = require('../lineup/report');

function createExecute({ isCommish = isTxnCommish, storage = settings, activity = tracker, now = Date.now } = {}) {
  return async (interaction) => {
    if (!isCommish(interaction.user.id)) {
      await interaction.reply({ content: 'Only the configured league commish can use this command.', ephemeral: true });
      return;
    }
    const current = storage.loadSettings();
    if (interaction.options.getSubcommand() === 'settings') {
      for (const [option, key, getter] of [
        ['interval_minutes', 'intervalMinutes', 'getInteger'], ['inactive_days', 'inactiveDays', 'getInteger'],
        ['enabled', 'enabled', 'getBoolean'],
      ]) {
        const value = interaction.options[getter](option);
        if (value !== null) current[key] = value;
      }
      settings.validate(current);
      storage.write('settings', current);
      activity.reschedule();
      await interaction.reply({ ephemeral: true, content:
        `Lineup activity checks: **${current.enabled ? 'enabled' : 'paused'}**. Every ${current.intervalMinutes} minutes; ` +
        `review threshold ${current.inactiveDays} days. Reports are commish-only; no activity DMs are sent.\n` +
        `\`/lineup-activity settings interval_minutes:${current.intervalMinutes} inactive_days:${current.inactiveDays}\`` });
      return;
    }
    const inactiveDays = interaction.options.getInteger('inactive_days') ?? current.inactiveDays;
    settings.validate({ ...current, inactiveDays });
    await interaction.deferReply({ ephemeral: true });
    let state = activity.state();
    if (current.enabled && (!state?.lastScanAt || now() - state.lastScanAt >= current.intervalMinutes * 60_000 || state.lastError)) {
      try { await activity.scan(); } catch { /* The report explicitly marks retained data as stale. */ }
      state = activity.state();
    }
    await interaction.editReply(report(state, current, inactiveDays, now()));
  };
}

module.exports = {
  data: new SlashCommandBuilder().setName('lineup-activity').setDescription('Commish-only last recorded lineup changes')
    .addSubcommand((s) => s.setName('report').setDescription('Privately report each team’s last recorded lineup change')
      .addIntegerOption((o) => o.setName('inactive_days').setDescription('Days since a change to mark for review (default 7)').setMinValue(1).setMaxValue(365)))
    .addSubcommand((s) => s.setName('settings').setDescription('View or change lineup activity collection settings')
      .addIntegerOption((o) => o.setName('interval_minutes').setDescription('Minutes between history checks (15–1440)').setMinValue(15).setMaxValue(1440))
      .addIntegerOption((o) => o.setName('inactive_days').setDescription('Default review threshold in days (1–365)').setMinValue(1).setMaxValue(365))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or pause lineup history collection'))),
  execute: createExecute(),
  createExecute,
};
