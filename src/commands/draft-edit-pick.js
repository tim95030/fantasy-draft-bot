const { SlashCommandBuilder } = require('discord.js');
const { isAdmin, loadConfig } = require('../config');
const { pool } = require('../draft/players');
const { engine } = require('../draft/engine');
const { loadOrder, normalizeTeam, ownerIds } = require('../draft/order');

function assertEditPicksEnabled() {
  const config = loadConfig();
  if (!config.allowEditPicks) {
    throw new Error(
      'Pick editing is disabled. An admin can enable it with `/draft-setup allow_edit_picks:True`.',
    );
  }
}

function userOwnsPick(pick, userId) {
  const id = String(userId);
  if (Array.isArray(pick.ownerIds) && pick.ownerIds.map(String).includes(id)) return true;
  if (String(pick.discordUserId) === id) return true;
  // Also match via current order (in case older picks lack ownerIds)
  const order = loadOrder();
  return order.teams.some((raw, i) => {
    const team = normalizeTeam(raw, i);
    if (pick.teamName && team.teamName === pick.teamName) {
      return ownerIds(team).includes(id);
    }
    return false;
  });
}

function picksForUser(state, userId, { adminAll = false } = {}) {
  return state.picks
    .filter((p) => adminAll || userOwnsPick(p, userId))
    .slice()
    .sort((a, b) => a.round - b.round || a.pick - b.pick);
}

function searchUserPicks(query, userId, { adminAll = false } = {}) {
  const state = engine.getState();
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const picks = picksForUser(state, userId, { adminAll });
  const scored = [];
  for (const p of picks) {
    const label = `${p.round}.${p.pick} ${p.teamName || p.displayName || ''} ${p.playerName} ${p.position}, ${p.team}`;
    const hay = label.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (hay.startsWith(q) || `${p.round}.${p.pick}`.startsWith(q)) score = 90;
    else if (hay.includes(q)) score = 50;
    else continue;
    scored.push({ score, p, label });
  }
  scored.sort((a, b) => b.score - a.score || a.p.round - b.p.round || a.p.pick - b.p.pick);
  return scored.slice(0, 25);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-edit-pick')
    .setDescription('Replace one of your drafted players with an available player')
    .addStringOption((o) =>
      o
        .setName('slot')
        .setDescription('Which of your picks to edit')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Replacement player (available only)')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addBooleanOption((o) =>
      o
        .setName('all_teams')
        .setDescription('Admin only: show/edit picks from every team'),
    ),

  async autocomplete(interaction) {
    try {
      assertEditPicksEnabled();
    } catch {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused(true);
    const adminAll =
      Boolean(interaction.options.getBoolean('all_teams')) &&
      isAdmin(interaction.user.id, interaction.member);

    if (focused.name === 'slot') {
      const results = searchUserPicks(focused.value, interaction.user.id, { adminAll });
      await interaction.respond(
        results.map(({ p, label }) => ({
          name: label.slice(0, 100),
          value: `${p.round}.${p.pick}`.slice(0, 100),
        })),
      );
      return;
    }

    if (focused.name === 'player') {
      const results = pool.search(focused.value, { availableOnly: true, limit: 25 });
      await interaction.respond(
        results.map((p) => ({
          name: `${pool.formatLabel(p)}`.slice(0, 100),
          value: p.fantraxId.slice(0, 100),
        })),
      );
    }
  },

  async execute(interaction) {
    try {
      assertEditPicksEnabled();
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
      return;
    }

    const slotRaw = interaction.options.getString('slot');
    const fantraxId = interaction.options.getString('player');
    const allTeams = interaction.options.getBoolean('all_teams') || false;
    const admin = isAdmin(interaction.user.id, interaction.member);
    const adminOverride = allTeams && admin;

    const m = String(slotRaw || '').match(/^(\d+)\.(\d+)$/);
    if (!m) {
      await interaction.reply({
        content: 'Pick a slot from the autocomplete list (format like `32.5`).',
        ephemeral: true,
      });
      return;
    }
    const round = Number(m[1]);
    const pick = Number(m[2]);

    try {
      const result = engine.replacePick({
        discordUserId: interaction.user.id,
        round,
        pick,
        newFantraxId: fantraxId,
        adminOverride,
      });

      const channel = await engine.getDraftChannel();
      const msg =
        `Edited **${result.previous.round}.${result.previous.pick}** for **${result.pickRecord.teamName || result.pickRecord.displayName}**: ` +
        `~~${result.previous.playerName} ${result.previous.position}, ${result.previous.team}~~ → **${result.line.replace(/^\d+\.\d+\s+/, '')}** ` +
        `(${result.previous.playerName} returned to the pool)`;

      // Public so the room sees corrections; keep ephemeral if not in draft channel
      if (channel && interaction.channelId === channel.id) {
        await interaction.reply(msg);
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
        if (channel) await channel.send(msg);
      }
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
