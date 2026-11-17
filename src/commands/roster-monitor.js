const { SlashCommandBuilder } = require('discord.js');
const { isTxnCommish } = require('../config');
const settings = require('../monitor/settings');
const { monitor } = require('../monitor');

module.exports = {
  data: new SlashCommandBuilder().setName('roster-monitor').setDescription('Commish-only roster monitoring settings and status')
    .addSubcommand((s) => s.setName('settings').setDescription('View or change roster monitor timing')
      .addIntegerOption((o) => o.setName('interval_minutes').setDescription('Minutes between checks (5–1440)').setMinValue(5).setMaxValue(1440))
      .addIntegerOption((o) => o.setName('escalate_after_cycles').setDescription('Successful cycles after owner warning (1–96)').setMinValue(1).setMaxValue(96))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or pause all roster monitor checks'))
      .addBooleanOption((o) => o.setName('season_active').setDescription('Enforce in-season callup and no-senddown rules')))
    .addSubcommand((s) => s.setName('status').setDescription('Show monitor health and current issues privately')),
  async execute(interaction) {
    if (!isTxnCommish(interaction.user.id)) {
      await interaction.reply({ content: 'Only the configured league commish can use this command.', ephemeral: true });
      return;
    }
    const current = settings.loadSettings();
    if (interaction.options.getSubcommand() === 'settings') {
      for (const [option, key, getter] of [
        ['interval_minutes', 'intervalMinutes', 'getInteger'], ['escalate_after_cycles', 'escalateAfterCycles', 'getInteger'],
        ['enabled', 'enabled', 'getBoolean'], ['season_active', 'seasonActive', 'getBoolean'],
      ]) {
        const value = interaction.options[getter](option);
        if (value !== null) current[key] = value;
      }
      settings.validateSettings(current);
      settings.write('settings', current);
      monitor.reschedule();
    }
    const state = settings.read('state', null);
    const issues = Object.values(state?.incidents || {});
    await interaction.reply({ ephemeral: true, content:
      `Roster monitor: **${current.enabled ? 'enabled' : 'paused'}**; season rules: **${current.seasonActive ? 'on' : 'off'}**.\n` +
      `${settings.settingsHint(current)}\nLast successful scan: ${state?.lastScanAt ? new Date(state.lastScanAt).toISOString() : 'not yet run'}.\n` +
      `Current issues: ${issues.filter((i) => !i.baseline).length} new; ${issues.filter((i) => i.baseline).length} baseline-only.` });
  },
};
