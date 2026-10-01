const { SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { pool } = require('../draft/players');
const { engine } = require('../draft/engine');
const {
  loadOrder,
  normalizeTeam,
  slotOwnedBy,
  ownerIds,
} = require('../draft/order');

/**
 * Match a fantasy team to a queue/skip slot by team identity — not owner IDs.
 * Owner overlap is wrong when allow_duplicate_owners lets one Discord user
 * own multiple teams (e.g. admin catch-up for Sharks while another owned
 * team is on the clock).
 */
function teamMatchesSlot(team, slot, teamIndex = null) {
  if (!team || !slot) return false;
  if (
    teamIndex != null &&
    Number.isInteger(slot.teamIndex) &&
    Number(slot.teamIndex) === Number(teamIndex)
  ) {
    return true;
  }
  const teamName = String(team.teamName || '')
    .trim()
    .toLowerCase();
  const slotName = String(slot.teamName || slot.displayName || '')
    .trim()
    .toLowerCase();
  return Boolean(teamName && slotName && teamName === slotName);
}

function resolveTeamFromOption(value) {
  const order = loadOrder();
  const m = String(value || '').match(/^slot:(\d+)$/i);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= order.teams.length) return null;
    return { index: idx, team: normalizeTeam(order.teams[idx], idx) };
  }
  // Fallback: match by team name
  const want = String(value || '')
    .trim()
    .toLowerCase();
  const idx = order.teams.findIndex(
    (t, i) => normalizeTeam(t, i).teamName.toLowerCase() === want,
  );
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
    const current = engine.currentSlot(state);

    let round;
    let pick;
    let drafterId = interaction.user.id;
    let adminOverride = false;

    if (targetTeam) {
      adminOverride = true;
      const owners = ownerIds(targetTeam.team);
      drafterId = owners[0] || interaction.user.id;
      const idx = targetTeam.index;

      const teamSkips = state.skipped
        .filter(
          (s) =>
            !engine.isFilled(state, s.round, s.pick) &&
            teamMatchesSlot(targetTeam.team, s, idx),
        )
        .sort((a, b) => a.round - b.round || a.pick - b.pick);
      const teamSkip = teamSkips[0];

      const onClockForTeam =
        current &&
        teamMatchesSlot(targetTeam.team, current, idx) &&
        !engine.isFilled(state, current.round, current.pick);

      if (onClockForTeam) {
        round = current.round;
        pick = current.pick;
      } else if (teamSkip) {
        round = teamSkip.round;
        pick = teamSkip.pick;
      } else {
        await interaction.reply({
          content: `**${targetTeam.team.teamName}** is not on the clock and has no open skipped picks. Use \`/draft-set-pick\` to force a specific round.pick.`,
          ephemeral: true,
        });
        return;
      }
    } else {
      const drafter = interaction.user.id;
      const openSkip = engine.openSkipsForUser(state, drafter)[0];
      if (
        current &&
        slotOwnedBy(current, drafter) &&
        !engine.isFilled(state, current.round, current.pick)
      ) {
        round = current.round;
        pick = current.pick;
      } else if (openSkip) {
        round = openSkip.round;
        pick = openSkip.pick;
      } else if (current) {
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
        await engine.announceOnClock(result.state);
      }
    } catch (err) {
      await interaction.reply({
        content: `${err.message}\n\nFormatted pick (copy/paste when ready):\n\`${line}\``,
        ephemeral: true,
      });
    }
  },
};
