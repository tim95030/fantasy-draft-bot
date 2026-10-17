const { PermissionFlagsBits, OverwriteType } = require('discord.js');

async function ensureActive(thread) {
  if (thread.archived) await thread.setArchived(false);
}

/**
 * After auction close: only the winner may post in the thread (contract years).
 * Requires bot **Manage Threads** on the parent channel.
 */
async function setWinnerOnlyPosting(thread, winnerUserId) {
  const guild = thread.guild;
  if (!guild) return false;
  try {
    await ensureActive(thread);
    const everyoneId = guild.roles.everyone.id;
    await thread.permissionOverwrites.edit(everyoneId, {
      deny: [PermissionFlagsBits.SendMessagesInThreads],
    });
    const allow = [PermissionFlagsBits.SendMessagesInThreads];
    const existing = thread.permissionOverwrites.cache.get(winnerUserId);
    if (existing) {
      await existing.edit({ allow, deny: [] });
    } else {
      await thread.permissionOverwrites.create({
        id: winnerUserId,
        type: OverwriteType.Member,
        allow,
      });
    }
    return true;
  } catch (err) {
    console.warn('setWinnerOnlyPosting failed:', err.message);
    return false;
  }
}

/** Remove thread-level posting overrides after lock (inherits parent channel again). */
async function clearThreadPostingOverrides(thread, winnerUserId) {
  if (!thread.guild) return;
  try {
    if (winnerUserId) {
      await thread.permissionOverwrites.delete(winnerUserId).catch(() => {});
    }
    await thread.permissionOverwrites.delete(thread.guild.roles.everyone.id).catch(() => {});
  } catch (err) {
    console.warn('clearThreadPostingOverrides failed:', err.message);
  }
}

module.exports = { setWinnerOnlyPosting, clearThreadPostingOverrides };
