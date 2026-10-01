const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');
const { loadCommands } = require('./loadCommands');

function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel],
  });
  client.commands = loadCommands();
  return client;
}

module.exports = { createClient };
