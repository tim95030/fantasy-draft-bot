const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../draft/players');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-pool')
    .setDescription('Search the player pool for availability')
    .addSubcommand((sc) =>
      sc
        .setName('search')
        .setDescription('Search players by name, team, position, or Fantrax ID')
        .addStringOption((o) =>
          o
            .setName('query')
            .setDescription('Type at least 2 characters to search')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addBooleanOption((o) =>
          o
            .setName('include_taken')
            .setDescription('Include already-drafted players'),
        ),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'query') {
      await interaction.respond([]);
      return;
    }
    const includeTaken = interaction.options.getBoolean('include_taken') || false;
    const results = pool.search(focused.value, {
      availableOnly: !includeTaken,
      limit: 25,
    });
    await interaction.respond(
      results.map((p) => {
        const flag = p.taken ? 'taken' : 'avail';
        return {
          name: `${flag}: ${pool.formatLabel(p)}`.slice(0, 100),
          value: p.fantraxId.slice(0, 100),
        };
      }),
    );
  },

  async execute(interaction) {
    const raw = interaction.options.getString('query');
    const includeTaken = interaction.options.getBoolean('include_taken') || false;

    // Autocomplete submits fantraxId; free-typed text is a search query.
    const byId = pool.get(raw);
    if (byId) {
      const flag = byId.taken ? '❌ taken' : '✅ available';
      await interaction.reply({
        content: `${flag} **${byId.name}** ${byId.position}, ${byId.team} (\`${byId.fantraxId}\`)`,
        ephemeral: true,
      });
      return;
    }

    if (String(raw || '').trim().length < 2) {
      await interaction.reply({
        content: 'Type at least 2 characters (or pick from autocomplete).',
        ephemeral: true,
      });
      return;
    }

    const results = pool.search(raw, {
      availableOnly: !includeTaken,
      limit: 20,
    });

    if (!results.length) {
      await interaction.reply({ content: 'No matches.', ephemeral: true });
      return;
    }

    const lines = results.map((p) => {
      const flag = p.taken ? '❌ taken' : '✅ available';
      return `${flag} **${p.name}** ${p.position}, ${p.team} (\`${p.fantraxId}\`)`;
    });
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  },
};
