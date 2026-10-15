const { SlashCommandBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('../transactions/snapshot');
const threads = require('../transactions/threads');
const registry = require('../transactions/registry');
const common = require('../transactions/common');
const { contractLabel, playerLabel } = require('../transactions/format');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('drop-player')
    .setDescription('Drop a player from your Fantrax roster')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Player on your roster (shows contract and salary)')
        .setRequired(true)
        .setAutocomplete(true),
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
    const { team } = common.resolveTeam(interaction);
    if (!team) {
      await interaction.respond([]);
      return;
    }
    const snap = await snapshot.getSnapshot();
    const fxTeam = snapshot.fantraxTeamFor(team.teamName, snap.ownership);
    if (!fxTeam) {
      await interaction.respond([]);
      return;
    }
    const q = snapshot.fold(focused.value);
    const rows = snapshot
      .rosterRows(fxTeam, snap.directory)
      .filter((r) => !q || snapshot.fold(r.name).includes(q))
      .slice(0, 25);
    await interaction.respond(
      rows.map((r) => ({ name: `${r.label} — ${r.contract}`.slice(0, 100), value: r.id })),
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

    await interaction.deferReply({ ephemeral: true });
    try {
      const snap = await snapshot.getSnapshot();
      const id = fantrax.normalizeFantraxId(interaction.options.getString('player'));
      const ownership = await fantrax.fetchRosterOwnership();
      const fxTeam = snapshot.fantraxTeamFor(team.teamName, ownership);
      if (!fxTeam) throw new Error(`No Fantrax roster found for **${team.teamName}**.`);
      const item = fxTeam.items.find((i) => i.id === id);
      if (!item) throw new Error(`That player isn't on the ${team.teamName} Fantrax roster.`);

      const player = snap.directory.get(id) || { id, name: id, position: item.position, team: '' };
      const label = playerLabel(player);
      const contract = contractLabel(item);
      const channel = await interaction.client.channels.fetch(common.targetChannelId('drop', cfg));

      const result = await threads.withLock(threads.registryKey('drop', id), async () => {
        const existing = await threads.findThread(interaction.client, 'drop', id, channel.id);
        if (existing) return { error: `There's already a drop thread for ${label}:`, thread: existing };
        const thread = await threads.createThread(channel, {
          kind: 'drop',
          playerId: id,
          title: common.threadTitle('drop', label, cfg),
          reason: `/drop-player by ${interaction.user.tag}`,
          meta: { player, status: 'posted' },
        });
        await threads.postInThread(
          thread,
          `${team.teamName} are dropping ${player.name} (${contract}) — <@${interaction.user.id}>`,
          [interaction.user.id],
        );
        return { thread };
      });

      if (result.error) {
        await interaction.editReply(`${result.error} ${result.thread}`);
        return;
      }
      registry.recordDrop({ teamName: team.teamName, playerId: id, playerName: player.name });
      audit('txn.drop', {
        fantraxId: `i${id}`,
        player: label,
        contract,
        teamName: team.teamName,
        by: interaction.user.id,
        threadId: result.thread.id,
      });
      await interaction.editReply(`Opened ${result.thread} — dropping ${player.name} (${contract}).`);
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
