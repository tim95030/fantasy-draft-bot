const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

function loadCommands() {
  const commands = new Collection();
  const dir = path.join(__dirname, 'commands');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const cmd = require(path.join(dir, file));
    if (cmd?.data?.name) commands.set(cmd.data.name, cmd);
  }
  return commands;
}

module.exports = { loadCommands };
