const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');
const fantrax = require('../draft/fantrax');

const DISCORD_CHUNK = 1900;

function chunkLines(lines) {
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > DISCORD_CHUNK && buf) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : ['(empty)'];
}

function groupPendingByTeam(pending) {
  const groups = new Map();
  for (const row of pending) {
    const team = row.discordTeam || 'Unknown';
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team).push(row);
  }
  return groups;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-fantrax')
    .setDescription('Admin: compare Discord picks to Fantrax rosters')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('check')
        .setDescription('List Discord picks missing from Fantrax or on the wrong team'),
    )
    .addSubcommand((sc) =>
      sc.setName('status').setDescription('Show Fantrax config and roster fetch health'),
    )
    .addSubcommand((sc) =>
      sc.setName('test').setDescription('Fetch Fantrax rosters once (smoke test)'),
    ),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const leagueId = fantrax.getLeagueId();

    if (sub === 'status') {
      await interaction.reply({
        content: leagueId
          ? `Fantrax league id configured: \`${leagueId}\`\nUse \`/draft-fantrax test\` or \`/draft-fantrax check\`.`
          : 'FANTRAX_LEAGUE_ID is **not** set in `.env` on the host.',
        ephemeral: true,
      });
      return;
    }

    if (!leagueId) {
      await interaction.reply({
        content: 'FANTRAX_LEAGUE_ID is not set in `.env`.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      if (sub === 'test') {
        const ownership = await fantrax.fetchRosterOwnership({ force: true });
        await interaction.editReply(
          [
            `Fantrax fetch **ok** for \`${ownership.leagueId}\``,
            `• Teams: **${ownership.teamCount}**`,
            `• Rostered players: **${ownership.playerCount}**`,
            ownership.period != null ? `• Period: **${ownership.period}**` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      // check
      const ownership = await fantrax.fetchRosterOwnership({ force: true });
      const picks = engine.getState().picks || [];
      const diff = fantrax.diffPicksAgainstRosters(picks, ownership);

      const lines = [
        '**Fantrax check**',
        `Discord picks: **${diff.discordTotal}** · Matched: **${diff.ok}** · Pending: **${diff.pending.length}** · Wrong team: **${diff.wrongTeam.length}**`,
        `Fantrax rosters: **${diff.fantraxTeams}** teams / **${diff.fantraxPlayers}** players`,
        '',
      ];

      if (!diff.pending.length && !diff.wrongTeam.length) {
        lines.push('_All Discord picks are on the expected Fantrax team._');
      } else {
        if (diff.pending.length) {
          lines.push(`**Pending** (not on any Fantrax roster) — ${diff.pending.length}`);
          const groups = groupPendingByTeam(diff.pending);
          for (const [team, rows] of groups) {
            lines.push(`**${team}**`);
            for (const row of rows) lines.push(`• ${fantrax.formatPickLine(row)}`);
          }
          lines.push('');
        }
        if (diff.wrongTeam.length) {
          lines.push(`**Wrong team** — ${diff.wrongTeam.length}`);
          for (const row of diff.wrongTeam) {
            lines.push(
              `• ${fantrax.formatPickLine(row)} — Discord: **${row.discordTeam}** · Fantrax: **${row.fantraxTeam}**`,
            );
          }
        }
      }

      const chunks = chunkLines(lines);
      await interaction.editReply({ content: chunks[0] });
      for (let i = 1; i < chunks.length; i += 1) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
    } catch (err) {
      await interaction.editReply(`Fantrax error: ${err.message}`);
    }
  },
};
