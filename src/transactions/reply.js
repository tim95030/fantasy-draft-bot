const { PermissionFlagsBits } = require('discord.js');

/** Ephemeral success text — omit thread link if the member cannot view the FA channel. */
function txnSuccessReply(interaction, channel, thread, bodyWithoutThread) {
  const member = interaction.member;
  const canView =
    channel && member && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel);
  if (canView && thread) {
    return `${bodyWithoutThread} ${thread}`;
  }
  const name = channel?.name ? `#${channel.name}` : 'the FA channel';
  return `${bodyWithoutThread} for **${name}**. If you cannot see the thread, ask commish for **View Channel** on that channel.`;
}

function explainDiscordAccessError(err, channelId, channelName) {
  if (err?.code === 50001 || /missing access/i.test(String(err?.message))) {
    return (
      `**Missing access** posting to **${channelName || 'FA channel'}** (\`${channelId}\`). ` +
      'Commish: on **#nhl-adds** / **#ahl-adds** / **#drops**, allow the **bot role**: ' +
      '**View Channel**, **Send Messages in Threads**, **Create Public Threads**, **Manage Threads** ' +
      '(**Send Messages** on the channel helps on some servers). ' +
      'GMs still need **View Channel** to open thread links.'
    );
  }
  return err?.message || 'Something went wrong.';
}

module.exports = { txnSuccessReply, explainDiscordAccessError };
