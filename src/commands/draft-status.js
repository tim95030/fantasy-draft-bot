const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { engine } = require('../draft/engine');
const { mentionOwners } = require('../draft/order');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-status')
    .setDescription('Show who is on the clock, timer, and open skips'),

  async execute(interaction) {
    const { state, slot, secondsLeft, openSkips } = engine.statusSummary();
    const embed = new EmbedBuilder()
      .setTitle('Draft status')
      .setColor(state.status === 'running' ? 0x1f6feb : 0x6e7681)
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
          value: secondsLeft != null ? `${secondsLeft}s` : '—',
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
          value:
            openSkips.length === 0
              ? 'None'
              : openSkips
                  .slice(0, 20)
                  .map(
                    (s) =>
                      `${s.round}.${s.pick} ${s.teamName || s.displayName || ''} ${mentionOwners(s)}`,
                  )
                  .join('\n') +
                (openSkips.length > 20 ? `\n…+${openSkips.length - 20} more` : ''),
        },
      );

    await interaction.reply({ embeds: [embed] });
  },
};
