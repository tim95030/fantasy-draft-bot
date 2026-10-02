require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('./client');
const { ensureConfigFile } = require('./config');
const { pool } = require('./draft/players');
const { ensureOrderFile } = require('./draft/order');
const { engine } = require('./draft/engine');
const paths = require('./paths');
const { version } = require('../package.json');

async function main() {
  console.log(`fantasy-draft-bot v${version} starting`);

  if (!process.env.DISCORD_TOKEN) {
    console.error('Missing DISCORD_TOKEN in .env');
    process.exit(1);
  }

  ensureConfigFile();
  ensureOrderFile();

  if (!fs.existsSync(paths.PLAYERS_CSV)) {
    if (fs.existsSync(paths.PLAYERS_DEFAULT)) {
      fs.copyFileSync(paths.PLAYERS_DEFAULT, paths.PLAYERS_CSV);
    } else if (fs.existsSync(paths.PLAYERS_SAMPLE)) {
      fs.copyFileSync(paths.PLAYERS_SAMPLE, paths.PLAYERS_CSV);
    }
  }

  try {
    const n = pool.loadFromFile();
    console.log(`Loaded ${n} players (${pool.available().length} available).`);
    const playerQueue = require('./draft/playerQueue');
    if (playerQueue.pruneTakenFromAllQueues(pool)) {
      console.log('Pruned already-drafted players from pick queues.');
    }
  } catch (err) {
    console.warn(`Players not loaded yet: ${err.message}`);
  }

  const client = createClient();
  engine.bindClient(client);

  const eventsDir = path.join(__dirname, 'events');
  for (const file of fs.readdirSync(eventsDir).filter((f) => f.endsWith('.js'))) {
    const event = require(path.join(eventsDir, file));
    client.on(event.name, (...args) => event.execute(...args, client));
  }

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    engine.resumeTimerIfNeeded();
    engine.startSleepWatcher();
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
