const { rosterFull } = require('./roster');

const HOUR_MS = 60 * 60 * 1000;

/**
 * Reason an existing registry row should be retired before a new transaction
 * for the same player, or null if the row still blocks.
 */
function staleEntryReason(entry, { now = Date.now(), dropCooldownHours = 48 } = {}) {
  if (!entry) return null;
  if (entry.kind === 'nhl' && entry.status === 'closed') return 'closed_without_winner';
  if (entry.kind === 'drop') {
    const created = Date.parse(entry.createdAt || 0);
    if (Number.isFinite(created) && now - created >= dropCooldownHours * HOUR_MS) {
      return 'previous_drop';
    }
  }
  return null;
}

/** Statuses a drop should clear so the player can be auctioned or claimed again. */
function retireOnDrop(entry) {
  if (!entry) return false;
  if (entry.kind === 'nhl') return ['won', 'closed'].includes(entry.status);
  if (entry.kind === 'ahl') return true;
  return false;
}

/** Statuses retired when the auction/claim thread is deleted in Discord. */
function retireOnThreadDelete(entry) {
  if (!entry) return false;
  if (entry.kind === 'nhl') return ['open', 'closed'].includes(entry.status);
  return true;
}

/**
 * What to do about the NHL auction winner's drop at close:
 * `file` the saved drop, flag it `missing` from their roster, ask for one (`needs_drop`), or `none`.
 */
function winnerDropAction(savedDrop, rosterItems, counts, limits) {
  if (savedDrop) {
    return (rosterItems || []).some((i) => i.id === savedDrop.playerId) ? 'file' : 'missing';
  }
  return rosterFull('nhl', counts, limits) ? 'needs_drop' : 'none';
}

/**
 * Whether a drop can still be linked to this add. Archived threads are finished.
 * AHL claims are finished once the commish locks them; NHL auction threads are locked by the bot
 * while awaiting the Fantrax add, so only archiving finishes them.
 */
function addLinkOpen(entry, thread) {
  if (!thread || thread.archived) return false;
  if (entry?.kind === 'ahl') return !thread.locked;
  return true;
}

module.exports = { staleEntryReason, retireOnDrop, retireOnThreadDelete, winnerDropAction, addLinkOpen };
