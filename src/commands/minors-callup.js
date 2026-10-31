const { SlashCommandBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('../transactions/snapshot');
const threads = require('../transactions/threads');
const common = require('../transactions/common');
const { playerLabel } = require('../transactions/format');
const { txnSuccessReply } = require('../transactions/reply');
const { logTxnUserMessage, reportTxnCommandFailure } = require('../transactions/txnLog');
const { CALLUP_CONTRACT, callupError } = require('../transactions/callups');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('minors-callup')
    .setDescription('Call up a minors player on your roster to the pro roster (permanent)')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Player on your roster with a Minors contract')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('for_team')
        .setDescription('Your team if you own several; admins can pick any team')
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
      .filter((r) => !callupError(r.item, r.name))
      .filter((r) => !q || snapshot.fold(r.name).includes(q))
      .slice(0, 25);
    await interaction.respond(rows.map((r) => ({ name: r.label.slice(0, 100), value: r.id })));
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
    const { team, actingUserId, error } = common.resolveTeam(interaction);
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
      const player = snap.directory.get(id) || { id, name: id, position: item?.position || '', team: '' };
      const notEligible = callupError(item, player.name);
      if (notEligible) throw new Error(notEligible);

      const label = playerLabel(player);
      const channelId = common.targetChannelId('callup', cfg);
      const channel = await interaction.client.channels.fetch(channelId);

      const result = await threads.withLock(threads.registryKey('callup', id), async () => {
        const existing = await threads.findThread(interaction.client, 'callup', id, channel.id);
        if (existing) return { error: `There's already a callup thread for ${label}:`, thread: existing };
        const thread = await threads.createThread(channel, {
          kind: 'callup',
          playerId: id,
          title: common.threadTitle('callup', label, cfg),
          reason: `/minors-callup by ${interaction.user.tag}`,
          meta: { player, status: 'requested', teamName: team.teamName },
        });
        await threads.postInThread(
          thread,
          `${team.teamName} call up ${player.name} — <@${actingUserId}>\nContract: **${CALLUP_CONTRACT}**`,
          [actingUserId],
        );
        return { thread };
      });

      if (result.error) {
        const userFacing = `${result.error} ${result.thread}`;
        logTxnUserMessage(interaction, {
          command: 'minors-callup',
          targetChannelId: channelId,
          channelLabel: '#minors-callups',
          teamName: team.teamName,
          fantraxId: `i${id}`,
          step: 'withLock',
          errorMessage: result.error,
        }, userFacing);
        await interaction.editReply(userFacing);
        return;
      }
      const auditRow = {
        fantraxId: `i${id}`,
        player: label,
        teamName: team.teamName,
        by: actingUserId,
        threadId: result.thread.id,
      };
      if (String(actingUserId) !== String(interaction.user.id)) {
        auditRow.commandBy = interaction.user.id;
      }
      audit('txn.callup', auditRow);
      const proxy =
        String(actingUserId) !== String(interaction.user.id)
          ? ` (for <@${actingUserId}>)`
          : '';
      await interaction.editReply(
        await txnSuccessReply(
          interaction,
          channel,
          result.thread,
          `Opened callup — **${team.teamName}** call up **${player.name}**${proxy}.`,
        ),
      );
    } catch (err) {
      await interaction.editReply(
        reportTxnCommandFailure(interaction, err, {
          command: 'minors-callup',
          targetChannelId: common.targetChannelId('callup', cfg),
          channelLabel: '#minors-callups',
          teamName: team?.teamName,
          playerInput: interaction.options.getString('player'),
        }),
      );
    }
  },
};
