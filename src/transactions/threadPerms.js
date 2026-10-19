const { PermissionFlagsBits, OverwriteType, PermissionOverwrites } = require('discord.js');
const { Routes } = require('discord-api-types/v10');
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

function threadRest(thread) {
  if (!thread?.client?.rest) throw new Error('thread has no REST client');
  return thread.client.rest;
}

/** Public threads are channels in the API but lack permissionOverwrites in discord.js — use REST. */
async function upsertThreadOverwrite(thread, targetId, type, options) {
  const { allow, deny } = PermissionOverwrites.resolveOverwriteOptions(options);
  await threadRest(thread).put(Routes.channelPermission(thread.id, targetId), {
    body: { id: targetId, type, allow, deny },
  });
}

async function deleteThreadOverwrite(thread, targetId) {
  await threadRest(thread).delete(Routes.channelPermission(thread.id, targetId)).catch(() => {});
}

async function addUsersToThreadMembers(thread, userIds) {
  for (const userId of userIds) {
    const id = String(userId);
    try {
      await thread.members.add(id);
    } catch (err) {
      console.warn(`thread.members.add(${id}) failed:`, err.message);
    }
  }
}

/** Public threads: @everyone can read (posting still controlled by channel / auction rules). */
async function ensureEveryoneCanViewThread(thread) {
  const guild = thread.guild;
  if (!guild) return false;
  try {
    await ensureActive(thread);
    await upsertThreadOverwrite(thread, guild.roles.everyone.id, OverwriteType.Role, {
      allow: THREAD_VIEW,
    });
    return true;
  } catch (err) {
    console.warn('ensureEveryoneCanViewThread failed:', err.message);
    return false;
  }
}

/** League commish(es): thread member list + member overwrite when the API allows it. */
async function ensureCommishThreadAccess(thread, commishIds = null) {
  const guild = thread.guild;
  if (!guild) return false;
  const ids = commishIds ?? loadConfig().transactions?.commishUserIds ?? [];
  if (!ids.length) return true;
  try {
    await ensureActive(thread);
    await addUsersToThreadMembers(thread, ids);
    for (const userId of ids) {
      const id = String(userId);
      await upsertThreadMemberOverwrite(thread, id, {
        allow: COMMISH_THREAD_ALLOW,
        deny: [],
      });
    }
    return true;
  } catch (err) {
    console.warn('ensureCommishThreadAccess failed:', err.message);
    return false;
  }
}

async function upsertThreadMemberOverwrite(thread, userId, options) {
  await upsertThreadOverwrite(thread, userId, OverwriteType.Member, options);
}

/**
 * After auction close: only the winner may post in the thread (contract years).
 * Uses thread channel permission REST routes (discord.js ThreadChannel has no overwrite manager).
 * Requires bot **Manage Roles** on the parent channel to set overwrites; otherwise the bot
 * still deletes non-winner posts in `handleWinnerYears`.
 */
async function setWinnerOnlyPosting(thread, winnerUserId) {
  const guild = thread.guild;
  if (!guild) return false;
  try {
    await ensureActive(thread);
    const everyoneId = guild.roles.everyone.id;
    await upsertThreadOverwrite(thread, everyoneId, OverwriteType.Role, {
      allow: THREAD_VIEW,
      deny: [PermissionFlagsBits.SendMessagesInThreads],
    });
    const allow = [...THREAD_VIEW, PermissionFlagsBits.SendMessagesInThreads];
    await upsertThreadMemberOverwrite(thread, winnerUserId, { allow, deny: [] });
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
      await deleteThreadOverwrite(thread, winnerUserId);
    }
    await deleteThreadOverwrite(thread, thread.guild.roles.everyone.id);
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
  upsertThreadOverwrite,
  addUsersToThreadMembers,
};
