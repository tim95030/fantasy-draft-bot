const { SlashCommandBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('../transactions/snapshot');
const threads = require('../transactions/threads');
const common = require('../transactions/common');
const { parseSalary, formatSalary, playerLabel } = require('../transactions/format');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nhl-add')
    .setDescription('Bid on an unrostered NHL (non-minors) player')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Unrostered, non-minors-eligible player')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('salary').setDescription('Bid, e.g. 850k or 1.2m (minimum 850k)').setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('for_team')
        .setDescription('Only if you own more than one team')
        .setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'for_team') {
      await interaction.respond(common.teamChoices(interaction, focused.value));
      return;
    }
    const snap = await snapshot.getSnapshot();
    await interaction.respond(
      snapshot.search(snap.nhl, focused.value).map((p) => ({
        name: playerLabel(p).slice(0, 100),
        value: p.id,
      })),
    );
  },

  async execute(interaction) {
    const cfg = common.txnConfig();
    const gate = common.channelError(interaction, cfg);
    if (gate) {
      await interaction.reply({ content: gate, ephemeral: true });
      return;
    }
    const { team, error } = common.resolveTeam(interaction);
    if (error) {
      await interaction.reply({ content: error, ephemeral: true });
      return;
    }
    const amount = parseSalary(interaction.options.getString('salary'));
    if (!amount) {
      await interaction.reply({
        content: 'Salary must look like `850k`, `1.2m` or `1200000`.',
        ephemeral: true,
      });
      return;
    }
    if (amount < cfg.minBid) {
      await interaction.reply({
        content: `Minimum bid is **${formatSalary(cfg.minBid)}**.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const snap = await snapshot.getSnapshot();
      const id = fantrax.normalizeFantraxId(interaction.options.getString('player'));
      const player = snap.directory.get(id);
      if (!player) throw new Error('Player not found. Pick one from the autocomplete list.');
      const owner = (await fantrax.fetchRosterOwnership()).byPlayerId.get(id);
      if (owner) throw new Error(`${player.name} is already on **${owner}** in Fantrax.`);
      if (snap.minors.get(id)?.minors === 'Y') {
        throw new Error(`${player.name} is minors-eligible. Use \`/ahl-add\` instead.`);
      }

      const channel = await interaction.client.channels.fetch(common.targetChannelId('nhl', cfg));
      const label = playerLabel(player);
      const bidLine = `${formatSalary(amount)} — <@${interaction.user.id}> (${team.teamName})`;

      const result = await threads.withLock(threads.registryKey('nhl', id), async () => {
        const existing = await threads.findThread(interaction.client, 'nhl', id, channel.id);
        if (existing) {
          const highest = await threads.highestBid(existing);
          if (amount <= highest) {
            return {
              error: `Current highest bid on ${label} is **${formatSalary(highest)}** — yours must be higher.`,
              thread: existing,
            };
          }
          await threads.postInThread(existing, bidLine, [interaction.user.id]);
          return { thread: existing, created: false, previous: highest };
        }
        const thread = await threads.createThread(channel, {
          kind: 'nhl',
          playerId: id,
          title: common.threadTitle('nhl', label, cfg),
          reason: `/nhl-add by ${interaction.user.tag}`,
        });
        await threads.postInThread(thread, bidLine, [interaction.user.id]);
        return { thread, created: true };
      });

      if (result.error) {
        await interaction.editReply(`${result.error}\n${result.thread}`);
        return;
      }
      audit(result.created ? 'txn.nhl_add' : 'txn.nhl_bid', {
        fantraxId: `i${id}`,
        player: label,
        amount,
        previousHigh: result.previous ?? null,
        teamName: team.teamName,
        by: interaction.user.id,
        threadId: result.thread.id,
      });
      await interaction.editReply(
        `${result.created ? 'Opened' : 'Bid posted in'} ${result.thread} — **${formatSalary(amount)}** for ${label}.`,
      );
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
