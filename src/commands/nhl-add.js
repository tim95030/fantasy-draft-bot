const { SlashCommandBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('../transactions/snapshot');
const threads = require('../transactions/threads');
const registry = require('../transactions/registry');
const common = require('../transactions/common');
const { validateBidAmount, formatBidLine } = require('../transactions/bids');
const { applyBid, scheduleClose } = require('../transactions/auctions');
const { formatSalary, playerLabel, parseSalary } = require('../transactions/format');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nhl-add')
    .setDescription('Bid on an unrostered NHL (non-minors) player')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Unrostered NHL player or active auction')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('salary').setDescription('Bid, e.g. 850k (25k steps, +100k over high)').setRequired(true),
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
    const players = registry.searchNhlAutocomplete(snap, focused.value, snapshot.search);
    await interaction.respond(
      players.map((p) => ({
        name: `${p._auction ? '🔨 ' : ''}${playerLabel(p)}`.slice(0, 100),
        value: p.id.slice(0, 100),
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
    const fa = common.faWindowError(cfg);
    if (fa) {
      await interaction.reply({ content: fa, ephemeral: true });
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

    await interaction.deferReply({ ephemeral: true });
    try {
      const snap = await snapshot.getSnapshot();
      const id = fantrax.normalizeFantraxId(interaction.options.getString('player'));
      const player = registry.resolvePlayer(id, snap, 'nhl');
      if (!player) {
        throw new Error(
          'Player not found. Pick from autocomplete (active auctions show with 🔨).',
        );
      }

      const openEntry = registry.getEntry('nhl', id);
      if (openEntry?.status === 'awaiting_years') {
        throw new Error('This auction has ended and is waiting on the winner’s contract length.');
      }
      if (openEntry?.status && openEntry.status !== 'open') {
        throw new Error('This auction is no longer open for bids.');
      }

      const owner = (await fantrax.fetchRosterOwnership()).byPlayerId.get(id);
      if (owner) throw new Error(`${player.name} is already on **${owner}** in Fantrax.`);

      if (!openEntry || openEntry.status !== 'open') {
        if (snap.minors.get(id)?.minors === 'Y') {
          throw new Error(`${player.name} is minors-eligible. Use \`/ahl-add\` instead.`);
        }
      }

      const channel = await interaction.client.channels.fetch(common.targetChannelId('nhl', cfg));
      const label = playerLabel(player);
      const line = formatBidLine(amount, interaction.user.id, team.teamName);

      const result = await threads.withLock(threads.registryKey('nhl', id), async () => {
        const existing = await threads.findThread(interaction.client, 'nhl', id, channel.id);
        const prevHigh = registry.getEntry('nhl', id)?.highBid?.amount || 0;
        const amountErr = validateBidAmount(amount, prevHigh, cfg);
        if (amountErr) return { error: amountErr, thread: existing };

        if (existing) {
          if (!registry.getEntry('nhl', id)?.player) {
            registry.upsertEntry('nhl', id, { player, status: 'open' });
          }
          const bid = await applyBid({
            kind: 'nhl',
            playerId: id,
            amount,
            userId: interaction.user.id,
            teamName: team.teamName,
          });
          if (bid.error) return { error: bid.error, thread: existing };
          const msg = await threads.postInThread(existing, line, [interaction.user.id]);
          registry.upsertEntry('nhl', id, { highBid: { ...bid.entry.highBid, messageId: msg.id } });
          return { thread: existing, created: false, previous: prevHigh };
        }

        const thread = await threads.createThread(channel, {
          kind: 'nhl',
          playerId: id,
          title: common.threadTitle('nhl', label, cfg),
          reason: `/nhl-add by ${interaction.user.tag}`,
          meta: {
            player,
            status: 'open',
            ineligibleUserIds: [],
          },
        });
        const bid = await applyBid({
          kind: 'nhl',
          playerId: id,
          amount,
          userId: interaction.user.id,
          teamName: team.teamName,
        });
        if (bid.error) return { error: bid.error, thread };
        const msg = await threads.postInThread(thread, line, [interaction.user.id]);
        registry.upsertEntry('nhl', id, { highBid: { ...bid.entry.highBid, messageId: msg.id } });
        scheduleClose(registry.getEntry('nhl', id));
        return { thread, created: true };
      });

      if (result.error) {
        const suffix = result.thread ? `\n${result.thread}` : '';
        await interaction.editReply(`${result.error}${suffix}`);
        return;
      }
      if (result.created) {
        audit('txn.nhl_add', {
          fantraxId: `i${id}`,
          player: label,
          amount,
          teamName: team.teamName,
          by: interaction.user.id,
          threadId: result.thread.id,
        });
      }
      await interaction.editReply(
        `${result.created ? 'Opened' : 'Bid posted in'} ${result.thread} — **${formatSalary(amount)}** for ${label}.`,
      );
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
