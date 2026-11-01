const { SlashCommandBuilder } = require('discord.js');
const { audit } = require('../draft/audit');
const snapshot = require('../transactions/snapshot');
const threads = require('../transactions/threads');
const registry = require('../transactions/registry');
const common = require('../transactions/common');
const { playerLabel } = require('../transactions/format');
const { txnSuccessReply } = require('../transactions/reply');
const { logTxnUserMessage, reportTxnCommandFailure } = require('../transactions/txnLog');
const { resolveDrop, fileDrop, saveAuctionDrop, teamKey } = require('../transactions/drops');

const AHL_LINK_DAYS = 7;

function threadUrl(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

/** Open NHL auctions, NHL auctions this team won, and this team's recent AHL claims. */
function linkableAdds(teamName) {
  const key = teamKey(teamName);
  const cutoff = Date.now() - AHL_LINK_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const entry of Object.values(registry.loadRegistry())) {
    const name = entry.player ? playerLabel(entry.player) : entry.title || entry.playerId;
    if (entry.kind === 'nhl' && entry.status === 'open') {
      out.push({ name: `🔨 ${name} (open auction)`, value: `nhl:${entry.playerId}`, entry });
    } else if (
      entry.kind === 'nhl' &&
      ['awaiting_years', 'won'].includes(entry.status) &&
      teamKey(entry.winner?.teamName) === key
    ) {
      out.push({ name: `${name} (auction won)`, value: `nhl:${entry.playerId}`, entry });
    } else if (
      entry.kind === 'ahl' &&
      entry.status === 'claimed' &&
      teamKey(entry.teamName) === key &&
      Date.parse(entry.createdAt || 0) >= cutoff
    ) {
      out.push({ name: `${name} (AHL claim)`, value: `ahl:${entry.playerId}`, entry });
    }
  }
  return out;
}

async function linkDrop(interaction, { team, playerId, forAdd }) {
  const match = linkableAdds(team.teamName).find((a) => a.value === forAdd);
  if (!match) {
    throw new Error(
      `**${forAdd}** isn't an add you can link a drop to. Pick one from \`for_add\` autocomplete ` +
        '(open NHL auctions, NHL auctions you won, or your AHL claims from the last week).',
    );
  }
  const { entry } = match;
  const addLabel = entry.player ? playerLabel(entry.player) : entry.title;
  const addUrl = threadUrl(interaction.guildId, entry.threadId);

  if (entry.kind === 'nhl' && entry.status === 'open') {
    const drop = await resolveDrop(team.teamName, playerId);
    saveAuctionDrop(entry.playerId, team.teamName, drop, interaction.user.id);
    audit('txn.drop_linked', {
      fantraxId: `i${drop.id}`,
      player: drop.label,
      teamName: team.teamName,
      auctionFantraxId: `i${entry.playerId}`,
      by: interaction.user.id,
    });
    return (
      `Drop of **${drop.label}** is saved and will only be filed if **${team.teamName}** wins **${addLabel}**. ` +
      `Auction: ${addUrl}`
    );
  }

  const result = await fileDrop({
    client: interaction.client,
    teamName: team.teamName,
    playerId,
    byUserId: interaction.user.id,
    linkedAddUrl: addUrl,
    reason: `/drop-player for_add by ${interaction.user.tag}`,
  });
  if (result.error) return `${result.error} ${result.thread}`;

  const addThread = await interaction.client.channels.fetch(entry.threadId).catch(() => null);
  if (addThread) await threads.postInThread(addThread, `Linked drop: ${result.thread.url}`);
  if (entry.kind === 'nhl') {
    registry.upsertEntry('nhl', entry.playerId, { linkedDropThreadId: result.thread.id });
  }
  return txnSuccessReply(
    interaction,
    result.channel,
    result.thread,
    `Opened drop thread — **${result.drop.player.name}** (${result.drop.contract}), linked to **${addLabel}**.`,
  );
}

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
    )
    .addStringOption((o) =>
      o
        .setName('for_add')
        .setDescription('Link this drop to your NHL auction or AHL claim')
        .setAutocomplete(true),
    ),

  linkableAdds,

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
    const q = snapshot.fold(focused.value);
    if (focused.name === 'for_add') {
      await interaction.respond(
        linkableAdds(team.teamName)
          .filter((a) => !q || snapshot.fold(a.name).includes(q))
          .slice(0, 25)
          .map((a) => ({ name: a.name.slice(0, 100), value: a.value })),
      );
      return;
    }
    const snap = await snapshot.getSnapshot();
    const fxTeam = snapshot.fantraxTeamFor(team.teamName, snap.ownership);
    if (!fxTeam) {
      await interaction.respond([]);
      return;
    }
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
    const playerId = interaction.options.getString('player');
    const forAdd = interaction.options.getString('for_add');
    try {
      if (forAdd) {
        await interaction.editReply(await linkDrop(interaction, { team, playerId, forAdd }));
        return;
      }
      const result = await fileDrop({
        client: interaction.client,
        teamName: team.teamName,
        playerId,
        byUserId: interaction.user.id,
        reason: `/drop-player by ${interaction.user.tag}`,
      });
      if (result.error) {
        const userFacing = `${result.error} ${result.thread}`;
        logTxnUserMessage(interaction, {
          command: 'drop-player',
          targetChannelId: common.targetChannelId('drop', cfg),
          channelLabel: '#drops',
          teamName: team.teamName,
          fantraxId: `i${playerId}`,
          step: 'withLock',
          errorMessage: result.error,
        }, userFacing);
        await interaction.editReply(userFacing);
        return;
      }
      await interaction.editReply(
        await txnSuccessReply(
          interaction,
          result.channel,
          result.thread,
          `Opened drop thread — **${result.drop.player.name}** (${result.drop.contract}).`,
        ),
      );
    } catch (err) {
      await interaction.editReply(
        reportTxnCommandFailure(interaction, err, {
          command: 'drop-player',
          targetChannelId: common.targetChannelId('drop', cfg),
          channelLabel: '#drops',
          teamName: team?.teamName,
          playerInput: playerId,
        }),
      );
    }
  },
};
