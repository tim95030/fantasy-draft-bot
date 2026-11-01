const { playerLabel } = require('./format');

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** An add has already posted when its optional drop error is shown; retry only the drop. */
function linkedDropInputContext(interaction, kind, addId) {
  const forTeam = interaction.options.getString('for_team');
  return { interaction: {
    commandName: 'drop-player',
    options: { data: [
      { name: 'player', value: interaction.options.getString('drop') },
      ...(forTeam ? [{ name: 'for_team', value: forTeam }] : []),
      { name: 'for_add', value: `${kind}:${addId}` },
    ] },
  } };
}

/** Safe candidates for a retry; never guess which same-name player should be transacted. */
function playerCandidates(players, input) {
  const q = fold(input);
  if (q.length < 2) return [];
  const rows = [...players];
  const exactLabel = rows.filter((p) => fold(playerLabel(p)) === q);
  if (exactLabel.length) return exactLabel;
  return rows.filter((p) => fold(p.name).includes(q) || q.startsWith(`${fold(p.name)} `));
}

/** Keep every supplied option, replacing only the unresolved player/drop value. */
function retryPlayerMessage(interaction, optionName = 'player', candidates = []) {
  const options = interaction.options.data || [];
  const command = (id) => {
    const args = options.map((o) => `${o.name}:${o.name === optionName ? id : o.value}`);
    if (!options.some((o) => o.name === optionName)) args.unshift(`${optionName}:${id}`);
    return `/${interaction.commandName} ${args.join(' ')}`.replace(/[`\r\n]/g, '');
  };
  if (!candidates.length) {
    return `No matching player was found. Check the name or use their Fantrax ID in this format:\n\`\`\`\n${command('<Fantrax ID>')}\n\`\`\``;
  }
  const lines = ['Choose the correct player, then copy/paste their command and run it again:'];
  for (const p of candidates.slice(0, 5)) {
    const block = `\n${playerLabel(p)}\n\`\`\`\n${command(p.id)}\n\`\`\``;
    if (lines.join('').length + block.length > 1200) break;
    lines.push(block);
  }
  if (candidates.length > 5) lines.push('\nMore matches exist; narrow the name or select from autocomplete.');
  return lines.join('');
}

module.exports = { playerCandidates, retryPlayerMessage, linkedDropInputContext };
