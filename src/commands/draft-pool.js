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
            .setDescription('At least 2 characters')
            .setRequired(true),
        )
        .addBooleanOption((o) =>
          o
            .setName('include_taken')
            .setDescription('Include already-drafted players'),
        ),
    ),

  async execute(interaction) {
    const query = interaction.options.getString('query');
    const includeTaken = interaction.options.getBoolean('include_taken') || false;
    if (query.trim().length < 2) {
      await interaction.reply({
        content: 'Type at least 2 characters.',
        ephemeral: true,
      });
      return;
    }

    const results = pool.search(query, {
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
