const registry = require('../transactions/registry');
const { retireOnThreadDelete } = require('../transactions/lifecycle');
const { audit } = require('../draft/audit');

module.exports = {
  name: 'threadDelete',
  async execute(thread) {
    const entry = registry.entryByThreadId(thread.id);
    if (!entry) return;
    const retired = retireOnThreadDelete(entry);
    if (retired) registry.retireEntry(entry.kind, entry.playerId, 'thread_deleted');
    audit('txn.thread_deleted', {
      kind: entry.kind,
      fantraxId: `i${entry.playerId}`,
      status: entry.status,
      threadId: thread.id,
      retired,
    });
  },
};
