const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin, loadConfig, updateConfig } = require('../config');
const { engine } = require('../draft/engine');
const {
  loadOrder,
  saveOrder,
  validateOrder,
  normalizeTeam,
  resizeTeams,
  formatTeamLine,
} = require('../draft/order');
const { parseCsv } = require('../draft/players');

function parseOwnerTokens(str, guild) {
  const tokens = String(str || '').match(/<@!?\d+>|\d{15,20}/g) || [];
  return tokens.map((tok) => {
    const id = tok.replace(/[<@!>]/g, '');
    const member = guild?.members?.cache?.get(id);
    return {
      discordUserId: id,
      displayName: member?.displayName || member?.user?.username || '',
    };
  });
}

function parseTeamsFromCsv(text, guild) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV empty');

  const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, ''));
  const hasHeader = header.some((h) =>
    ['teamname', 'team', 'owners', 'ownerdiscordids', 'discorduserid', 'slot'].includes(h),
  );
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // Format A: teamName,ownerDiscordIds  (ids separated by ; or | or space)
  const teamNameIdx = hasHeader
    ? header.findIndex((h) => ['teamname', 'team', 'name'].includes(h))
    : 0;
  const ownersIdx = hasHeader
    ? header.findIndex((h) =>
        ['owners', 'ownerdiscordids', 'discorduserids', 'ownerids'].includes(h),
      )
    : 1;
  const singleIdIdx = hasHeader
    ? header.findIndex((h) => ['discorduserid', 'userid', 'id'].includes(h))
    : -1;
  const displayIdx = hasHeader
    ? header.findIndex((h) => ['displayname', 'ownername'].includes(h))
    : -1;
  const slotIdx = hasHeader ? header.findIndex((h) => h === 'slot') : -1;

  // Format B: multiple rows per team (slot or teamName + single discordUserId)
  if (singleIdIdx >= 0 && ownersIdx < 0) {
    const byKey = new Map();
    dataRows.forEach((r, i) => {
      const slot = slotIdx >= 0 ? String(r[slotIdx]).trim() : '';
      const teamName =
        (teamNameIdx >= 0 ? r[teamNameIdx] : '') ||
        (displayIdx >= 0 ? r[displayIdx] : '') ||
        `Team ${i + 1}`;
      const key = slot || String(teamName).toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          teamName: String(teamName).trim() || `Team ${byKey.size + 1}`,
          owners: [],
          sort: slot ? Number(slot) : byKey.size + 1,
        });
      }
      const id = String(r[singleIdIdx] || '')
        .replace(/[<@!>]/g, '')
        .trim();
      if (!id) return;
      const member = guild?.members?.cache?.get(id);
      byKey.get(key).owners.push({
        discordUserId: id,
        displayName:
          (displayIdx >= 0 ? String(r[displayIdx] || '').trim() : '') ||
          member?.displayName ||
          '',
      });
    });
    return [...byKey.values()]
      .sort((a, b) => a.sort - b.sort)
      .map(({ teamName, owners }) => ({ teamName, owners }));
  }

  return dataRows.map((r, i) => {
    const teamName =
      String((teamNameIdx >= 0 ? r[teamNameIdx] : r[0]) || '').trim() || `Team ${i + 1}`;
    const ownersRaw = ownersIdx >= 0 ? r[ownersIdx] : r[1];
    const owners = parseOwnerTokens(String(ownersRaw || ''), guild);
    return { teamName, owners };
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-order')
    .setDescription('Show, resize, or edit draft teams (name + co-owners)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc.setName('show').setDescription('Show the current draft order / teams'),
    )
    .addSubcommand((sc) =>
      sc
        .setName('size')
        .setDescription('Set how many team slots exist (1–64). Safe before /draft-start.')
        .addIntegerOption((o) =>
          o
            .setName('count')
            .setDescription('Number of teams')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(64),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('edit')
        .setDescription('Set team name + owners for one slot')
        .addIntegerOption((o) =>
          o
            .setName('slot')
            .setDescription('Slot number (1 = first pick in round 1 order)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(64),
        )
        .addStringOption((o) =>
          o.setName('team_name').setDescription('Fantasy team name').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('owners')
            .setDescription('One or more Discord @mentions or IDs (co-owners allowed)')
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('set')
        .setDescription('Replace full order from mentions or CSV')
        .addStringOption((o) =>
          o
            .setName('users')
            .setDescription('User mentions/IDs in pick order (1 owner per team)'),
        )
        .addAttachmentOption((o) =>
          o
            .setName('csv')
            .setDescription(
              'CSV: teamName,ownerDiscordIds  OR  slot,teamName,discordUserId rows',
            ),
        )
        .addBooleanOption((o) =>
          o.setName('snake').setDescription('Enable snake ordering'),
        )
        .addBooleanOption((o) =>
          o
            .setName('allow_duplicate_owners')
            .setDescription('Allow the same Discord user on multiple teams (testing)'),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const order = loadOrder();
    const config = loadConfig();

    if (sub === 'show') {
      const lines = order.teams.map((t, i) => formatTeamLine(t, i));
      const chunks = [];
      let buf = [
        `Snake: **${order.snake}**`,
        `Teams: **${order.teams.length}**`,
        `Allow duplicate owners: **${order.allowDuplicateOwners || config.allowDuplicateOwners || false}**`,
        '',
      ].join('\n');
      for (const line of lines) {
        if (buf.length + line.length + 1 > 1900) {
          chunks.push(buf);
          buf = '';
        }
        buf += `${line}\n`;
      }
      if (buf) chunks.push(buf);
      await interaction.reply({ content: chunks[0] || 'No teams set.', ephemeral: true });
      for (let i = 1; i < chunks.length; i += 1) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
      return;
    }

    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    if (sub === 'size') {
      const state = engine.getState();
      if (state.status === 'running' || state.status === 'paused') {
        await interaction.reply({
          content:
            'Cannot resize while a draft is active. `/draft-end` first (or finish), then resize, then `/draft-start`.',
          ephemeral: true,
        });
        return;
      }
      const count = interaction.options.getInteger('count');
      const next = resizeTeams(order, count);
      saveOrder(next);
      await interaction.reply({
        content: `Team slots set to **${count}**. Use \`/draft-order edit\` to set each team name + owners. Empty-owner slots must be filled before \`/draft-start\`.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'edit') {
      const slot = interaction.options.getInteger('slot');
      const teamName = interaction.options.getString('team_name');
      const ownersStr = interaction.options.getString('owners');
      if (slot > order.teams.length) {
        await interaction.reply({
          content: `Slot ${slot} does not exist yet. Current size is ${order.teams.length}. Run \`/draft-order size count:${slot}\` first (or larger).`,
          ephemeral: true,
        });
        return;
      }
      const owners = parseOwnerTokens(ownersStr, interaction.guild);
      if (!owners.length) {
        await interaction.reply({
          content: 'Provide at least one owner mention or Discord user ID.',
          ephemeral: true,
        });
        return;
      }
      const teams = order.teams.map((t, i) => normalizeTeam(t, i));
      teams[slot - 1] = { teamName, owners };
      const next = { ...order, teams };
      const err = validateOrder(next, {
        allowDuplicateOwners: next.allowDuplicateOwners || config.allowDuplicateOwners,
      });
      // Allow saving incomplete other slots; only validate this edit loosely if others empty
      if (err && !err.includes('needs at least one owner')) {
        // If error is about THIS team somehow ok; for duplicates still block
        if (err.includes('Duplicate owner')) {
          await interaction.reply({ content: err, ephemeral: true });
          return;
        }
      }
      // Re-validate only duplicate rule for partial rosters
      const dupErr = validateOrder(
        {
          ...next,
          teams: teams.filter((t) => t.owners.length),
        },
        {
          allowDuplicateOwners: next.allowDuplicateOwners || config.allowDuplicateOwners,
        },
      );
      if (dupErr && dupErr.includes('Duplicate')) {
        await interaction.reply({ content: dupErr, ephemeral: true });
        return;
      }
      saveOrder(next);
      await interaction.reply({
        content: `Updated slot **${slot}**: ${formatTeamLine(teams[slot - 1], slot - 1)}`,
        ephemeral: true,
      });
      return;
    }

    // set
    await interaction.deferReply({ ephemeral: true });
    const snakeOpt = interaction.options.getBoolean('snake');
    const allowDupOpt = interaction.options.getBoolean('allow_duplicate_owners');
    const usersStr = interaction.options.getString('users');
    const csvAtt = interaction.options.getAttachment('csv');
    let teams = [];

    if (csvAtt) {
      const res = await fetch(csvAtt.url);
      const text = await res.text();
      teams = parseTeamsFromCsv(text, interaction.guild);
    } else if (usersStr) {
      const owners = parseOwnerTokens(usersStr, interaction.guild);
      teams = owners.map((o, i) => ({
        teamName: o.displayName || `Team ${String(i + 1).padStart(2, '0')}`,
        owners: [o],
      }));
    } else {
      await interaction.editReply('Provide `users` or a `csv` attachment.');
      return;
    }

    const next = {
      snake: snakeOpt != null ? snakeOpt : order.snake,
      allowDuplicateOwners:
        allowDupOpt != null ? allowDupOpt : order.allowDuplicateOwners,
      teams,
    };
    if (allowDupOpt != null) {
      updateConfig({ allowDuplicateOwners: allowDupOpt });
    }
    const err = validateOrder(next, {
      allowDuplicateOwners: next.allowDuplicateOwners || loadConfig().allowDuplicateOwners,
    });
    if (err) {
      await interaction.editReply(err);
      return;
    }
    saveOrder(next);
    await interaction.editReply(
      `Draft order saved: **${teams.length}** teams, snake=${next.snake}, allow_duplicate_owners=${next.allowDuplicateOwners}.`,
    );
  },
};
