const { SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { pool } = require('../draft/players');
const { engine } = require('../draft/engine');
const {
  loadOrder,
  normalizeTeam,
  ownerIds,
} = require('../draft/order');

function resolveTeamFromOption(value) {
  const order = loadOrder();
  const m = String(value || '').match(/^slot:(\d+)$/i);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= order.teams.length) return null;
    return { index: idx, team: normalizeTeam(order.teams[idx], idx) };
  }
  // Fallback: match by team name (exact, then unique substring)
  const want = String(value || '')
    .trim()
    .toLowerCase();
  let idx = order.teams.findIndex(
    (t, i) => normalizeTeam(t, i).teamName.toLowerCase() === want,
  );
  if (idx < 0 && want) {
    const hits = order.teams
      .map((t, i) => ({ i, name: normalizeTeam(t, i).teamName.toLowerCase() }))
      .filter(({ name }) => name.includes(want) || want.includes(name));
    if (hits.length === 1) idx = hits[0].i;
  }
  if (idx < 0) return null;
  return { index: idx, team: normalizeTeam(order.teams[idx], idx) };
}

function searchTeams(query, limit = 25) {
  const order = loadOrder();
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const scored = [];
  order.teams.forEach((raw, i) => {
    const team = normalizeTeam(raw, i);
    const name = team.teamName.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 50;
    else if (String(i + 1) === q || `slot ${i + 1}`.includes(q)) score = 40;
    else return;
    scored.push({ score, i, team });
  });
  scored.sort(
    (a, b) => b.score - a.score || a.team.teamName.localeCompare(b.team.teamName),
  );
  return scored.slice(0, limit);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-player')
    .setDescription('Search available players and submit (or format) a pick')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Type at least 2 characters to search')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('for_team')
        .setDescription('Admin only: submit for a fantasy team (by name)')
        .setAutocomplete(true),
    )
    .addBooleanOption((o) =>
      o
        .setName('post_only')
        .setDescription('Only post the formatted pick line (do not auto-submit)'),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'player') {
      const results = pool.search(focused.value, { availableOnly: true, limit: 25 });
      await interaction.respond(
        results.map((p) => ({
          name: `${pool.formatLabel(p)}`.slice(0, 100),
          value: p.fantraxId.slice(0, 100),
        })),
      );
      return;
    }

    if (focused.name === 'for_team') {
      const results = searchTeams(focused.value, 25);
      await interaction.respond(
        results.map(({ i, team }) => ({
          name: `${team.teamName} (#${i + 1})`.slice(0, 100),
          value: `slot:${i + 1}`,
        })),
      );
    }
  },

  async execute(interaction) {
    const fantraxId = interaction.options.getString('player');
    const forTeamValue = interaction.options.getString('for_team');
    const postOnly = interaction.options.getBoolean('post_only') || false;
    const player = pool.get(fantraxId);
    const admin = isAdmin(interaction.user.id, interaction.member);

    if (!player) {
      await interaction.reply({
        content: 'Player not found. Use autocomplete to select one.',
        ephemeral: true,
      });
      return;
    }

    if (forTeamValue && !admin) {
      await interaction.reply({
        content: 'Only admins can draft for another team (`for_team`).',
        ephemeral: true,
      });
      return;
    }

    let targetTeam = null;
    if (forTeamValue) {
      targetTeam = resolveTeamFromOption(forTeamValue);
      if (!targetTeam) {
        await interaction.reply({
          content: 'Team not found. Use autocomplete to pick a fantasy team.',
          ephemeral: true,
        });
        return;
      }
    }

    const state = engine.getState();
    engine.syncTeamsFromOrder(state);
    const current = engine.currentSlot(state);

    let round;
    let pick;
    let drafterId = interaction.user.id;
    let adminOverride = false;

    if (targetTeam) {
      adminOverride = true;
      const owners = ownerIds(targetTeam.team);
      drafterId = owners[0] || interaction.user.id;

      const target = engine.oldestOpenSlotForTeam(
        state,
        targetTeam.team,
        targetTeam.index,
      );
      if (!target) {
        await interaction.reply({
          content: `**${targetTeam.team.teamName}** is not on the clock and has no open skipped picks. Use \`/draft-set-pick\` to force a specific round.pick.`,
          ephemeral: true,
        });
        return;
      }
      round = target.round;
      pick = target.pick;
    } else {
      const drafter = interaction.user.id;
      const target = engine.oldestOpenSlotForUser(state, drafter);
      if (target) {
        round = target.round;
        pick = target.pick;
      } else if (current) {
        // Not their turn / no skip — still format against the clock for post_only / error hint
        round = current.round;
        pick = current.pick;
      } else {
        const config = engine.getConfig();
        round = config.startRound;
        pick = 1;
      }
    }

    const line = pool.formatPickLine(round, pick, player);

    if (postOnly) {
      await interaction.reply(line);
      return;
    }

    try {
      const result = engine.submitPick({
        discordUserId: drafterId,
        fantraxId,
        round,
        pick,
        adminOverride,
        source: 'command',
      });

      const teamLabel =
        result.pickRecord.teamName || result.pickRecord.displayName || 'team';
      await interaction.reply(
        `Drafted: **${result.line}** → **${teamLabel}**` +
          (result.pickRecord.catchUp ? ' _(catch-up skip)_' : ''),
      );

      if (result.wasCurrent && result.state.status === 'running') {
        await engine.proceedToNextPick();
      }
    } catch (err) {
      await interaction.reply({
        content: `${err.message}\n\nFormatted pick (copy/paste when ready):\n\`${line}\``,
        ephemeral: true,
      });
    }
  },
};
