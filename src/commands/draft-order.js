const {
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { isAdmin } = require('../config');
const {
  loadOrder,
  saveOrder,
  validateOrder,
  EXPECTED_TEAMS,
} = require('../draft/order');
const { parseCsv } = require('../draft/players');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-order')
    .setDescription('Show or set the exact draft order (32 teams)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('show')
        .setDescription('Show the current draft order'),
    )
    .addSubcommand((sc) =>
      sc
        .setName('set')
        .setDescription('Set order from 32 user mentions (space-separated) or a CSV attachment')
        .addStringOption((o) =>
          o
            .setName('users')
            .setDescription('32 Discord user mentions or IDs in pick order'),
        )
        .addAttachmentOption((o) =>
          o
            .setName('csv')
            .setDescription('CSV with discordUserId,displayName (32 rows)'),
        )
        .addBooleanOption((o) =>
          o.setName('snake').setDescription('Enable snake ordering'),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'show') {
      const order = loadOrder();
      const lines = order.teams.map(
        (t, i) => `**${i + 1}.** <@${t.discordUserId}> (${t.displayName || '—'})`,
      );
      const chunks = [];
      let buf = `Snake: **${order.snake}** · Teams: **${order.teams.length}/${EXPECTED_TEAMS}**\n`;
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

    await interaction.deferReply({ ephemeral: true });

    const snakeOpt = interaction.options.getBoolean('snake');
    const usersStr = interaction.options.getString('users');
    const csvAtt = interaction.options.getAttachment('csv');
    const current = loadOrder();
    let teams = [];

    if (csvAtt) {
      const res = await fetch(csvAtt.url);
      const text = await res.text();
      const rows = parseCsv(text);
      if (!rows.length) throw new Error('CSV empty');
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const hasHeader =
        header.includes('discorduserid') ||
        header.includes('userid') ||
        header.includes('id');
      const dataRows = hasHeader ? rows.slice(1) : rows;
      const idIdx = hasHeader
        ? header.findIndex((h) =>
            ['discorduserid', 'userid', 'id', 'discord_id'].includes(h),
          )
        : 0;
      const nameIdx = hasHeader
        ? header.findIndex((h) => ['displayname', 'name', 'team'].includes(h))
        : 1;
      teams = dataRows.map((r, i) => ({
        discordUserId: String(r[idIdx]).replace(/[<@!>]/g, '').trim(),
        displayName: (nameIdx >= 0 ? r[nameIdx] : '') || `Team ${i + 1}`,
      }));
    } else if (usersStr) {
      const tokens = usersStr.match(/<@!?\d+>|\d{15,20}/g) || [];
      teams = tokens.map((tok, i) => {
        const id = tok.replace(/[<@!>]/g, '');
        const member = interaction.guild.members.cache.get(id);
        return {
          discordUserId: id,
          displayName: member?.displayName || member?.user?.username || `Team ${i + 1}`,
        };
      });
    } else {
      await interaction.editReply('Provide `users` or a `csv` attachment.');
      return;
    }

    const order = {
      snake: snakeOpt != null ? snakeOpt : current.snake,
      teams,
    };
    const err = validateOrder(order);
    if (err) {
      await interaction.editReply(err);
      return;
    }
    saveOrder(order);
    await interaction.editReply(
      `Draft order saved (${teams.length} teams, snake=${order.snake}).`,
    );
  },
};
