const { PermissionFlagsBits, OverwriteType } = require('discord.js');
const { loadConfig } = require('../config');

const THREAD_VIEW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

const COMMISH_THREAD_ALLOW = [
  ...THREAD_VIEW,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
];

async function ensureActive(thread) {
  if (thread.archived) await thread.setArchived(false);
}

/** Public threads: @everyone can read (posting still controlled by channel / auction rules). */
async function ensureEveryoneCanViewThread(thread) {
  const guild = thread.guild;
  if (!guild) return false;
  try {
    await ensureActive(thread);
    await thread.permissionOverwrites.edit(guild.roles.everyone.id, {
      allow: THREAD_VIEW,
    });
    return true;
  } catch (err) {
    console.warn('ensureEveryoneCanViewThread failed:', err.message);
    return false;
  }
}

/** League commish(es): can read/post in FA threads even when winner-only or locked. */
async function ensureCommishThreadAccess(thread, commishIds = null) {
  const guild = thread.guild;
  if (!guild) return false;
  const ids = commishIds ?? loadConfig().transactions?.commishUserIds ?? [];
  if (!ids.length) return true;
  try {
    await ensureActive(thread);
    for (const userId of ids) {
      const id = String(userId);
      const existing = thread.permissionOverwrites.cache.get(id);
      if (existing) {
        await existing.edit({ allow: COMMISH_THREAD_ALLOW, deny: [] });
      } else {
        await thread.permissionOverwrites.create({
          id,
          type: OverwriteType.Member,
          allow: COMMISH_THREAD_ALLOW,
        });
      }
    }
    return true;
  } catch (err) {
    console.warn('ensureCommishThreadAccess failed:', err.message);
    return false;
  }
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
      allow: THREAD_VIEW,
      deny: [PermissionFlagsBits.SendMessagesInThreads],
    });
    const allow = [...THREAD_VIEW, PermissionFlagsBits.SendMessagesInThreads];
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
    await ensureCommishThreadAccess(thread);
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

module.exports = {
  COMMISH_THREAD_ALLOW,
  ensureEveryoneCanViewThread,
  ensureCommishThreadAccess,
  setWinnerOnlyPosting,
  clearThreadPostingOverrides,
};
