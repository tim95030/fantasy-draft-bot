const { loadConfig, isAdmin } = require('../config');
const { pool } = require('../draft/players');
const { parsePickMessage } = require('../draft/parser');
const { engine } = require('../draft/engine');

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const config = loadConfig();
    if (!config.draftChannelId || message.channelId !== config.draftChannelId) return;

    const state = engine.getState();
    if (state.status !== 'running' && state.status !== 'paused') return;

    const parsed = parsePickMessage(message.content);
    if (!parsed) return;

    const matches = pool.resolveByIdentity(
      parsed.playerName,
      parsed.position,
      parsed.team,
    );

    if (!matches.length) {
      const byName = pool.findByName(parsed.playerName).slice(0, 8);
      const hint = byName.length
        ? `Did you mean:\n${byName
            .map((p) => `• ${p.name} ${p.position}, ${p.team} (\`${p.fantraxId}\`)${p.taken ? ' [taken]' : ''}`)
            .join('\n')}`
        : 'No matching player in the pool. Check spelling / POS / TEAM.';
      await message.reply(hint);
      return;
    }

    if (matches.length > 1) {
      await message.reply(
        `Ambiguous player. Candidates:\n${matches
          .map((p) => `• ${p.name} ${p.position}, ${p.team} (\`${p.fantraxId}\`)`)
          .join('\n')}`,
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
        await engine.announceOnClock(result.state);
      }
    } catch (err) {
      await message.reply(err.message);
    }
  },
};
