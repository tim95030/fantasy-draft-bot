const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const snapshot = require('../transactions/snapshot');
const common = require('../transactions/common');
const { formatSalary } = require('../transactions/format');
const { spotsLine, splitRosterRows } = require('../transactions/roster');
const { teamRosterState } = require('../transactions/drops');

const EMBED_DESCRIPTION_MAX = 4096;

function rowLine(row) {
  const tags = row.tags.length ? ` _(${row.tags.join(', ')})_` : '';
  return `${row.label} — ${row.contract}${tags}`;
}

/** Cap section from Fantrax totals; minors-slot players don't count and dead cap is included in used. */
function capLines(cap) {
  if (!cap) return ['_Salary cap unavailable from Fantrax right now._'];
  const lines = [];
  if (cap.deadCap.length) {
    lines.push('**Dead cap**');
    for (const d of cap.deadCap) {
      const until = d.endingSeasonYear ? ` (through ${d.endingSeasonYear})` : '';
      lines.push(`${d.name} — ${formatSalary(d.amount)}${until}`);
    }
    lines.push('');
  }
  lines.push(`**Cap: ${formatSalary(cap.used)} used of ${formatSalary(cap.cap)}  ·  ${formatSalary(cap.remaining)} space**`);
  return lines;
}

function rosterDescription(teamName, rows, counts, limits, pendingDrops, cap) {
  const { nhl, minors } = splitRosterRows(rows, { pendingDrops });
  const section = (title, list) => [`**${title} (${list.length})**`, ...(list.length ? list.map(rowLine) : ['_None_'])];
  const tail = ['', ...(cap === undefined ? [] : [...capLines(cap), '']), spotsLine(counts, limits)].join('\n');
  const text = [...section('NHL list', nhl), '', ...section('Minors list', minors)].join('\n') + '\n' + tail;
  if (text.length <= EMBED_DESCRIPTION_MAX) return text;
  const footer = `\n…\n${tail}`;
  return text.slice(0, EMBED_DESCRIPTION_MAX - footer.length) + footer;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-roster')
    .setDescription('Show your Fantrax roster, salary cap, and open spots — only you see it')
    .addStringOption((o) =>
      o
        .setName('for_team')
        .setDescription('Your team if you own several; admins can pick any team')
        .setAutocomplete(true),
    ),

  rosterDescription,
  capLines,

  async autocomplete(interaction) {
    await interaction.respond(common.teamChoices(interaction, interaction.options.getFocused()));
  },

  async execute(interaction) {
    const { team, error } = common.resolveTeam(interaction);
    if (error) {
      await interaction.reply({ content: error, ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const [snap, ownership] = await Promise.all([snapshot.getSnapshot(), fantrax.fetchRosterOwnership()]);
      const fxTeam = snapshot.fantraxTeamFor(team.teamName, ownership);
      if (!fxTeam) {
        await interaction.editReply(`No Fantrax roster found for **${team.teamName}**.`);
        return;
      }
      const cap = await fantrax.fetchTeamCap(fxTeam.teamId).catch((err) => {
        console.warn(`Cap lookup for ${team.teamName} failed:`, err.message);
        return null;
      });
      const rows = snapshot.rosterRows(fxTeam, snap.directory);
      const state = teamRosterState(fxTeam, team.teamName);
      const embed = new EmbedBuilder()
        .setTitle(`${team.teamName} roster`)
        .setDescription(rosterDescription(team.teamName, rows, state.counts, state.limits, state.pendingDrops, cap))
        .setFooter({
          text:
            'From Fantrax (refreshed within the last minute). Cap excludes minors and includes dead cap. ' +
            'IR and players with a drop pending do not use a spot.',
        });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('/my-roster failed:', err);
      await interaction.editReply(`Could not load the roster: ${err.message}`);
    }
  },
};
