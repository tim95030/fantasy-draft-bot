const { loadConfig, isAdmin } = require('../config');
const { pool } = require('../draft/players');
const { parsePickMessage, formatPickLine } = require('../draft/parser');
const { engine } = require('../draft/engine');

const LOOKS_LIKE_PICK_RE = /^\s*\d+\.\d+\s+\S/;

async function deleteQuietly(message) {
  try {
    if (message.deletable) await message.delete();
  } catch {
    // Missing Manage Messages or already gone
  }
}

async function notifyUser(message, content) {
  const body = `${content}\n\n_Your pick message in the draft channel was removed. Paste a corrected line there to try again._`;
  try {
    await message.author.send(body);
    return;
  } catch {
    // DMs closed — fall back to a short channel reply, then delete it
  }
  try {
    const reply = await message.channel.send({
      content: `<@${message.author.id}> ${content}`,
      allowedMentions: { users: [message.author.id] },
    });
    setTimeout(() => {
      reply.delete().catch(() => {});
    }, 45_000);
  } catch {
    // ignore
  }
}

function suggestionBlock(round, pick, players) {
  if (!players.length) {
    return 'No close matches in the pool. Check spelling / POS / TEAM, or use `/draft-player`.';
  }
  const lines = players.map((p) => {
    const line = formatPickLine(round, pick, p.name, p.position, p.team);
    const flag = p.taken ? ' _(already taken)_' : '';
    return `• \`${line}\`${flag}`;
  });
  return `Did you mean:\n${lines.join('\n')}\n\nCopy/paste one of those lines into the draft channel.`;
}

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const config = loadConfig();
    if (!config.draftChannelId || message.channelId !== config.draftChannelId) return;

    const state = engine.getState();
    if (state.status !== 'running' && state.status !== 'paused') return;

    const text = String(message.content || '').trim();
    const parsed = parsePickMessage(text);
    const looksLikePick = LOOKS_LIKE_PICK_RE.test(text);

    if (!parsed) {
      if (!looksLikePick) return;
      await deleteQuietly(message);
      await notifyUser(
        message,
        'Pick format not recognized.\nUse: `Rd.pick Player Name POS, TEAM`\nExample: `32.5 Connor McDavid C, EDM`\nOr use `/draft-player` (autocomplete).',
      );
      return;
    }

    const matches = pool.resolveByIdentity(
      parsed.playerName,
      parsed.position,
      parsed.team,
    );

    if (!matches.length) {
      const byName = pool.findByName(parsed.playerName);
      let suggestions = byName.length
        ? byName.slice(0, 5)
        : pool.suggest(parsed.playerName, { limit: 5 });

      // If name matches but POS/TEAM wrong, prefer those
      if (!suggestions.length) {
        suggestions = pool.search(parsed.playerName, {
          availableOnly: false,
          limit: 5,
        });
      }

      await deleteQuietly(message);
      await notifyUser(
        message,
        suggestionBlock(parsed.round, parsed.pick, suggestions),
      );
      return;
    }

    if (matches.length > 1) {
      await deleteQuietly(message);
      await notifyUser(
        message,
        `Ambiguous player. ${suggestionBlock(parsed.round, parsed.pick, matches.slice(0, 5))}`,
      );
      return;
    }

    const player = matches[0];
    try {
      const result = engine.submitPick({
        discordUserId: message.author.id,
        fantraxId: player.fantraxId,
        round: parsed.round,
        pick: parsed.pick,
        adminOverride: isAdmin(message.author.id, message.member),
        source: 'message',
      });

      await message.react('✅');
      await message.reply(
        `Recorded **${result.line}** for <@${result.pickRecord.discordUserId}>` +
          (result.pickRecord.catchUp ? ' _(catch-up skip)_' : ''),
      );

      if (result.wasCurrent && result.state.status === 'running') {
        await engine.proceedToNextPick();
      }
    } catch (err) {
      const suggestions = pool.suggest(parsed.playerName, {
        availableOnly: true,
        limit: 5,
      });
      await deleteQuietly(message);
      let body = err.message;
      if (suggestions.length) {
        body += `\n\n${suggestionBlock(parsed.round, parsed.pick, suggestions)}`;
      } else {
        body += '\n\nOr use `/draft-player` (autocomplete).';
      }
      await notifyUser(message, body);
    }
  },
};
