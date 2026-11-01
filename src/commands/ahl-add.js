const { SlashCommandBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const { audit } = require('../draft/audit');
const snapshot = require('../transactions/snapshot');
const threads = require('../transactions/threads');
const registry = require('../transactions/registry');
const common = require('../transactions/common');
const { playerLabel } = require('../transactions/format');
const { txnSuccessReply } = require('../transactions/reply');
const { logTxnUserMessage, reportTxnCommandFailure } = require('../transactions/txnLog');
const { fileDrop, dropChoices, teamRosterState } = require('../transactions/drops');
const { rosterFull, fullRosterNotice } = require('../transactions/roster');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ahl-add')
    .setDescription('Add an unrostered minors-eligible (green M) player')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Unrostered green-M player with NHL contract history')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('for_team')
        .setDescription('Your team if you own several; admins can pick any team')
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('drop')
        .setDescription('Optional: player to drop, filed and linked with this add')
        .setAutocomplete(true),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'for_team') {
      await interaction.respond(common.teamChoices(interaction, focused.value));
      return;
    }
    if (focused.name === 'drop') {
      await interaction.respond(await dropChoices(interaction, focused.value, 'ahl'));
      return;
    }
    const snap = await snapshot.getSnapshot();
    await interaction.respond(
      snapshot.search(snap.ahl, focused.value).map((p) => ({
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
      const player = registry.resolvePlayer(id, snap, 'ahl') || snap.directory.get(id);
      if (!player) throw new Error('Player not found. Pick one from the autocomplete list.');
      const ownership = await fantrax.fetchRosterOwnership();
      const owner = ownership.byPlayerId.get(id);
      if (owner) throw new Error(`${player.name} is already on **${owner}** in Fantrax.`);
      const dropId = interaction.options.getString('drop');
      const cooldown = cfg.dropCooldownHours ?? 48;
      if (registry.dropBlocked(team.teamName, id, cooldown)) {
        throw new Error(
          `Your team dropped **${player.name}** within the last ${cooldown} hours. Other teams may add them; you cannot re-add yet.`,
        );
      }
      if (snap.minors.get(id)?.round !== '24') {
        throw new Error(
          `${player.name} is not an AHL add (needs the green M and NHL contract history).`,
        );
      }

      const channelId = common.targetChannelId('ahl', cfg);
      const channel = await interaction.client.channels.fetch(channelId);
      const label = playerLabel(player);

      const result = await threads.withLock(threads.registryKey('ahl', id), async () => {
        const existing = await threads.findThread(interaction.client, 'ahl', id, channel.id);
        if (existing) return { error: `There's already an AHL add thread for ${label}:`, thread: existing };
        const thread = await threads.createThread(channel, {
          kind: 'ahl',
          playerId: id,
          title: common.threadTitle('ahl', label, cfg),
          reason: `/ahl-add by ${interaction.user.tag}`,
          meta: { player, status: 'claimed', teamName: team.teamName },
        });
        await threads.postInThread(
          thread,
          `${team.teamName} add ${player.name} — <@${actingUserId}>`,
          [actingUserId],
        );
        return { thread };
      });

      if (result.error) {
        const userFacing = `${result.error} ${result.thread}`;
        logTxnUserMessage(interaction, {
          command: 'ahl-add',
          targetChannelId: channelId,
          channelLabel: '#ahl-adds',
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
      audit('txn.ahl_add', auditRow);
      const proxy =
        String(actingUserId) !== String(interaction.user.id)
          ? ` (for <@${actingUserId}>)`
          : '';
      let summary = await txnSuccessReply(
        interaction,
        channel,
        result.thread,
        `Opened AHL add — **${team.teamName}** add **${player.name}**${proxy}.`,
      );
      if (dropId) {
        try {
          const dropped = await fileDrop({
            client: interaction.client,
            teamName: team.teamName,
            playerId: dropId,
            byUserId: actingUserId,
            linkedAddUrl: result.thread.url,
            reason: `/ahl-add drop by ${interaction.user.tag}`,
          });
          if (dropped.error) {
            summary += `\n\nDrop not filed: ${dropped.error} ${dropped.thread}`;
          } else {
            await threads.postInThread(result.thread, `Linked drop: ${dropped.thread.url}`);
            summary += `\n\nLinked drop filed — **${dropped.drop.player.name}** (${dropped.drop.contract}). ${dropped.thread}`;
          }
        } catch (err) {
          summary += `\n\nDrop not filed: ${err.message}`;
        }
      } else {
        const fxTeam = snapshot.fantraxTeamFor(team.teamName, ownership);
        const { counts, limits } = teamRosterState(fxTeam, team.teamName, cfg);
        if (fxTeam && rosterFull('ahl', counts, limits)) {
          summary += `\n\n${fullRosterNotice('ahl', counts, limits, player.name)}`;
        }
      }
      await interaction.editReply(summary);
    } catch (err) {
      await interaction.editReply(
        reportTxnCommandFailure(interaction, err, {
          command: 'ahl-add',
          targetChannelId: common.targetChannelId('ahl', cfg),
          channelLabel: '#ahl-adds',
          teamName: team?.teamName,
          playerInput: interaction.options.getString('player'),
        }),
      );
    }
  },
};
