const { PermissionFlagsBits } = require('discord.js');

/** Shown when we omit a thread link because the member cannot view the FA channel. */
const GM_FA_ACCESS_HINT =
  'Discord **Missing Access** on a thread usually means your role cannot see that FA channel. ' +
  'Ask commish for **View Channel** and **Send Messages in Threads** on **#nhl-adds**, **#ahl-adds**, and **#drops**. ' +
  'Slash commands work from any channel; auction threads only live in those channels.';

function explainBotFaChannelAccess(channelId, channelLabel) {
  return (
    `The bot cannot post in **${channelLabel || 'FA channel'}** (\`${channelId}\`). ` +
    'Commish: on that channel, allow the **bot role**: **View Channel**, **Send Messages in Threads**, ' +
    '**Create Public Threads**, **Manage Threads**, **Manage Messages** (and **Send Messages** on the parent channel on some servers).'
  );
}

async function memberCanViewFaChannel(interaction, channel) {
  if (!channel?.guild || !interaction.user?.id) return false;
  const member = await channel.guild.members.fetch(interaction.user.id).catch(() => null);
  return member?.permissionsIn(channel)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

/** Ephemeral success — omit thread link if the member cannot view the FA parent channel. */
async function txnSuccessReply(interaction, channel, thread, bodyWithoutThread) {
  const canView = await memberCanViewFaChannel(interaction, channel);
  if (canView && thread) {
    return `${bodyWithoutThread} ${thread}`;
  }
  const name = channel?.name ? `#${channel.name}` : 'the FA channel';
  return `${bodyWithoutThread} in **${name}**. ${GM_FA_ACCESS_HINT}`;
}

function formatTxnCommandError(err, channelId, channelLabel) {
  const root = err?.cause || err;
  const code = root?.code ?? root?.rawError?.code ?? err?.code ?? err?.rawError?.code;
  const msg = String(err?.message || root?.message || '');
  if (code === 50001 || /missing access/i.test(msg)) {
    return explainBotFaChannelAccess(channelId, channelLabel);
  }
  if (err instanceof Error && msg && code === undefined && !err.rawError) {
    return msg;
  }
  return msg || 'Something went wrong.';
}

/** @deprecated use explainBotFaChannelAccess / formatTxnCommandError */
function explainDiscordAccessError(err, channelId, channelName) {
  if (err?.code === 50001 || /missing access/i.test(String(err?.message))) {
    return explainBotFaChannelAccess(channelId, channelName);
  }
  return err?.message || 'Something went wrong.';
}

module.exports = {
  GM_FA_ACCESS_HINT,
  memberCanViewFaChannel,
  txnSuccessReply,
  formatTxnCommandError,
  explainBotFaChannelAccess,
  explainDiscordAccessError,
};
