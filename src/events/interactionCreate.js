const { loadConfig } = require('../config');

/** Commands allowed outside the draft channel (so setup remains reachable). */
const CHANNEL_EXEMPT = new Set(['draft-setup']);

function draftChannelGate(interaction) {
  if (CHANNEL_EXEMPT.has(interaction.commandName)) return null;

  const config = loadConfig();
  if (!config.draftChannelId) {
    return 'No draft channel set. An admin must run `/draft-setup channel:#your-channel` first.';
  }
  if (String(interaction.channelId) !== String(config.draftChannelId)) {
    return `Draft commands only work in <#${config.draftChannelId}>.`;
  }
  return null;
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    if (interaction.isAutocomplete()) {
      const blocked = draftChannelGate(interaction);
      if (blocked) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const command = client.commands.get(interaction.commandName);
      if (!command?.autocomplete) return;
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error('Autocomplete error:', err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    const blocked = draftChannelGate(interaction);
    if (blocked) {
      await interaction.reply({ content: blocked, ephemeral: true }).catch(() => {});
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Command /${interaction.commandName} failed:`, err);
      const payload = {
        content: `Error: ${err.message || 'Something went wrong.'}`,
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
