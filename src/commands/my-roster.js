const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fantrax = require('../draft/fantrax');
const snapshot = require('../transactions/snapshot');
const common = require('../transactions/common');
const { rosterLimits, countRoster, spotsLine, splitRosterRows } = require('../transactions/roster');

const EMBED_DESCRIPTION_MAX = 4096;

function rowLine(row) {
  const tags = row.tags.length ? ` _(${row.tags.join(', ')})_` : '';
  return `${row.label} — ${row.contract}${tags}`;
}

function rosterDescription(teamName, rows, counts, limits) {
  const { nhl, minors } = splitRosterRows(rows);
  const section = (title, list) => [`**${title} (${list.length})**`, ...(list.length ? list.map(rowLine) : ['_None_'])];
  const lines = [...section('NHL list', nhl), '', ...section('Minors list', minors), '', spotsLine(counts, limits)];
  const text = lines.join('\n');
  if (text.length <= EMBED_DESCRIPTION_MAX) return text;
  const footer = `\n…\n\n${spotsLine(counts, limits)}`;
  return text.slice(0, EMBED_DESCRIPTION_MAX - footer.length) + footer;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-roster')
    .setDescription('Show your Fantrax roster (NHL list vs minors) and open spots — only you see it')
    .addStringOption((o) =>
      o
        .setName('for_team')
        .setDescription('Your team if you own several; admins can pick any team')
        .setAutocomplete(true),
    ),

  rosterDescription,

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
      const rows = snapshot.rosterRows(fxTeam, snap.directory);
      const embed = new EmbedBuilder()
        .setTitle(`${team.teamName} roster`)
        .setDescription(rosterDescription(team.teamName, rows, countRoster(fxTeam.items), rosterLimits(common.txnConfig())))
        .setFooter({ text: 'From Fantrax (refreshed within the last minute). IR does not use an NHL spot.' });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('/my-roster failed:', err);
      await interaction.editReply(`Could not load the roster: ${err.message}`);
    }
  },
};
