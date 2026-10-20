const { audit } = require('../draft/audit');

function serializeErr(err) {
  if (!err) return { message: 'unknown error' };
  const raw = err.rawError || err.cause?.rawError;
  return {
    name: err.name,
    message: String(err.message || '').slice(0, 2000),
    code: err.code ?? raw?.code,
    status: err.status ?? err.httpStatus ?? err.statusCode,
    method: err.method,
    url: err.url,
    discordCode: raw?.code,
    discordMessage: raw?.message ? String(raw.message).slice(0, 500) : undefined,
  };
}

function interactionContext(interaction) {
  if (!interaction) return {};
  return {
    userId: interaction.user?.id,
    userTag: interaction.user?.tag,
    commandChannelId: interaction.channelId,
    guildId: interaction.guildId,
  };
}

/**
 * Append txn.fail to audit.jsonl and stderr. Call before showing errors to users.
 */
function logTxnFailure(details) {
  const { err, ...rest } = details;
  const row = {
    ...rest,
    error: serializeErr(err),
  };
  audit('txn.fail', row);
  const tag = rest.command || rest.source || 'txn';
  const who = rest.userId || rest.userTag || '?';
  console.error(
    `[txn.fail] ${tag} user=${who} kind=${rest.failureKind || 'error'} ${row.error.message}`,
    row.error.code ? `code=${row.error.code}` : '',
  );
}

/** Log validation/business-rule failures (no Error object required). */
function logTxnUserMessage(interaction, meta, userMessage) {
  logTxnFailure({
    ...interactionContext(interaction),
    ...meta,
    failureKind: meta.failureKind || 'validation',
    userFacing: String(userMessage || '').slice(0, 2000),
    err: meta.err || new Error(meta.errorMessage || userMessage),
  });
}

/** Log, then return the ephemeral-safe message for editReply. */
function reportTxnCommandFailure(interaction, err, meta) {
  const { formatTxnCommandError } = require('./reply');
  const userFacing = formatTxnCommandError(err, meta.targetChannelId, meta.channelLabel);
  logTxnFailure({
    ...interactionContext(interaction),
    ...meta,
    failureKind: meta.failureKind || failureKindFromErr(err),
    userFacing,
    err,
  });
  return userFacing;
}

function failureKindFromErr(err) {
  const root = err?.cause || err;
  const code = root?.code ?? root?.rawError?.code ?? err?.code ?? err?.rawError?.code;
  if (code === 50001) return 'discord_missing_access';
  if (code === 50013) return 'discord_missing_permissions';
  if (err instanceof Error && code === undefined) return 'validation';
  return 'error';
}

module.exports = {
  serializeErr,
  logTxnFailure,
  logTxnUserMessage,
  reportTxnCommandFailure,
  failureKindFromErr,
};
