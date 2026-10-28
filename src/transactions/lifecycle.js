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

module.exports = { staleEntryReason, retireOnDrop, retireOnThreadDelete };
