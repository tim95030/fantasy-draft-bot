const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { engine } = require('../draft/engine');
const { mentionOwners } = require('../draft/order');
const { formatDuration } = require('../draft/formatDuration');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-status')
    .setDescription('Show who is on the clock, timer, and open skips'),

  async execute(interaction) {
    const { state, slot, secondsLeft, sleeping, sleepLabel, wakeLabel } =
      engine.statusSummary();
    const embed = new EmbedBuilder()
      .setTitle('Draft status')
      .setColor(state.status === 'running' ? (sleeping ? 0x6e7681 : 0x1f6feb) : 0x6e7681)
      .addFields(
        { name: 'Status', value: state.status, inline: true },
        {
          name: 'On the clock',
          value: slot
            ? `**${slot.round}.${slot.pick}** **${slot.teamName || slot.displayName}** (${mentionOwners(slot)})`
            : '—',
          inline: true,
        },
        {
          name: 'Time left',
          value: sleeping
            ? `⏸ Sleep · ${secondsLeft != null ? formatDuration(secondsLeft) : '—'} left` +
              (wakeLabel ? `\nResumes ${wakeLabel}` : '')
            : secondsLeft != null
              ? formatDuration(secondsLeft)
              : '—',
          inline: true,
        },
        {
          name: 'Sleep hours',
          value: sleepLabel,
          inline: true,
        },
        {
          name: 'Picks recorded',
          value: String(state.picks.length),
          inline: true,
        },
        {
          name: 'Queue progress',
          value: `${Math.min(state.currentIndex + 1, state.queue.length)} / ${state.queue.length || 0}`,
          inline: true,
        },
        {
          name: 'Open skips',
          value: engine.formatOpenSkipsByTeam(state),
        },
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
