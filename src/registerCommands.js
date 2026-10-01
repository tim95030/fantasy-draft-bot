require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { loadCommands } = require('./loadCommands');

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error('Set DISCORD_TOKEN and CLIENT_ID in .env');
    process.exit(1);
  }

  const commands = [...loadCommands().values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    const data = await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(`Registered ${data.length} guild commands to ${guildId}.`);
  } else {
    const data = await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });
    console.log(`Registered ${data.length} global commands (may take up to ~1 hour to appear).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
