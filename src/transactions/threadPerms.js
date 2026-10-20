const { loadConfig } = require('../config');

/**
 * Public FA threads inherit #nhl-adds / #ahl-adds / #drops permissions.
 * Discord does not allow permission overwrites on public threads ("Cannot execute action on this channel type").
 */

async function ensureActive(thread) {
  if (thread.archived) await thread.setArchived(false);
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

/** No-op for public threads (visibility comes from the parent channel). */
async function ensureEveryoneCanViewThread(_thread) {
  return true;
}

/** Add commish user(s) to the thread member list (sidebar / notifications). */
async function ensureCommishThreadAccess(thread, commishIds = null) {
  if (!thread.guild) return false;
  const ids = commishIds ?? loadConfig().transactions?.commishUserIds ?? [];
  if (!ids.length) return true;
  try {
    await ensureActive(thread);
    await addUsersToThreadMembers(thread, ids);
    return true;
  } catch (err) {
    console.warn('ensureCommishThreadAccess failed:', err.message);
    return false;
  }
}

/**
 * Winner-only posting is enforced by the bot deleting non-winner messages in `handleWinnerYears`.
 * Public threads cannot get per-thread permission overwrites from the API.
 */
async function setWinnerOnlyPosting(thread, _winnerUserId) {
  await ensureCommishThreadAccess(thread);
  return true;
}

/** No thread-level overwrites on public threads. */
async function clearThreadPostingOverrides(_thread, _winnerUserId) {}

module.exports = {
  ensureEveryoneCanViewThread,
  ensureCommishThreadAccess,
  setWinnerOnlyPosting,
  clearThreadPostingOverrides,
  addUsersToThreadMembers,
};
