# Fantasy Draft Bot

Local Discord bot for running an **ongoing fantasy draft** (designed for ~32 teams and ~7,000 players with Fantrax IDs). Supports snake or linear order, pick clocks, skipped-pick catch-up, CSV player pools, and mid-draft start rounds.

> **Local only.** Do **not** add a git remote or publish this repo. Keep tokens and league data on your machine.

## Features

- Draft order for **32 managers** (Discord users), with optional **snake**
- Configurable **start round** and **total rounds remaining** (e.g. start at round 32)
- Eligible player pool via CSV (`fantraxId`, name, position, NHL team, taken)
- Preset picks CSV to mark history before you resume
- Auto-advance when someone posts: `32.5 John Doe LW, ANA`
- Skipped picks stay claimable out of order by the owning manager
- `/draft-player` searchable autocomplete (Fantrax ID under the hood)
- Admin tools: setup, import, set-pick, skip, undo, export

## Requirements

- Node.js 18+
- A Discord application/bot with:
  - **Message Content Intent** enabled
  - **Server Members Intent** enabled (recommended)
  - Invited with `applications.commands` + `bot` scopes  
    Permissions: Send Messages, Embed Links, Attach Files, Read Message History, Use Slash Commands

## Quick start

```bash
cd ~/Code/fantasy-draft-bot
cp .env.example .env
# Edit .env: DISCORD_TOKEN, CLIENT_ID, optional GUILD_ID

cp data/config.sample.json data/config.json
cp data/draft-order.sample.json data/draft-order.json
cp data/players.sample.csv data/players.csv
# Replace players.csv with your ~7k Fantrax export (see format below)

npm install
npm run register-commands   # prefer GUILD_ID in .env for instant command registration
npm start
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | yes | Bot token |
| `CLIENT_ID` | yes | Application client ID (for command registration) |
| `GUILD_ID` | no | If set, registers slash commands to one server immediately |

## Data files

Live files under `data/` (except samples) are **gitignored**.

### `players.csv`

```csv
fantraxId,name,position,team,taken
FX001,Connor McDavid,C,EDM,true
FX003,John Doe,LW,ANA,false
```

- `fantraxId` — unique key (used by autocomplete)
- `name`, `position`, `team` — real-world identity (team is NHL/club, **not** fantasy team)
- `taken` — `true` if already drafted before this bot session

Upload anytime with `/draft-import-players`.

### `draft-order.json`

Exactly **32** entries:

```json
{
  "snake": true,
  "teams": [
    { "discordUserId": "123…", "displayName": "Alice" }
  ]
}
```

Set via `/draft-order set` (32 mentions/IDs) or CSV attachment (`discordUserId,displayName`).

### `config.json`

Managed mainly by `/draft-setup`:

- `adminUserIds` — who can run admin commands (also anyone with Manage Server)
- `draftChannelId` — only this channel accepts pick messages
- `startRound` / `totalRounds` / `secondsPerPick` / `snake`

### `preset-picks.csv` (optional)

Applied on `/draft-start`:

```csv
round,pick,fantraxId,drafterDiscordUserId
1,1,FX001,111111111111111111
```

Upload with `/draft-import-presets`.

### `draft-state.json`

Runtime state (clock, picks, skips). Created automatically. Safe to delete only when you want a hard reset (then `/draft-start` again).

## Pick format

```text
{round}.{pick} {Player Name} {POS}, {TEAM}
```

Example:

```text
32.5 John Doe LW, ANA
```

That means: round 32, pick 5 in that round → draft **John Doe** (LW on ANA) to the **posting manager’s** roster (or the slot owner when catching up / admin override).

Rules:

1. Must be your turn **or** an open **skipped** slot you own (use that slot’s `Rd.pick`)
2. Player must exist (name + POS + team) and not be taken
3. Ambiguous names get a “did you mean” list with Fantrax IDs

## Commands

### Admin

| Command | Purpose |
|---------|---------|
| `/draft-setup` | Channel, start round, rounds left, timer, snake, admins |
| `/draft-order show` / `set` | View or set the 32-team order |
| `/draft-import-players` | Replace player pool CSV |
| `/draft-import-presets` | Save preset picks for next start |
| `/draft-start` | Build queue from start round and go live |
| `/draft-pause` / `/draft-resume` | Pause/resume clock |
| `/draft-end` | Stop the draft |
| `/draft-skip` | Force-skip current pick (stays claimable) |
| `/draft-undo` | Undo last recorded pick |
| `/draft-set-pick` | Force-assign player to a `round` + `pick` |
| `/draft-export` | Download picks CSV (includes `fantraxId`) |

### Everyone

| Command | Purpose |
|---------|---------|
| `/draft-player` | Autocomplete search → submit pick (or `post_only`) |
| `/draft-status` | On the clock, timer, open skips |
| `/draft-board` | Recent picks (optional manager filter) |
| `/draft-pool search` | Availability check |

`/draft-player` tips:

- Type **≥2 characters**; results show `Name — POS, TEAM`
- Admins can use `for_manager` to submit for someone else
- `post_only: true` posts the formatted line without submitting

## Draft flow (recommended)

1. Invite the bot; run `/draft-setup` in the draft channel (sets you as admin)
2. `/draft-order set` with all 32 managers in first-round order
3. `/draft-import-players` with full Fantrax CSV (`taken=true` for already picked)
4. Optional: `/draft-import-presets` for board history
5. `/draft-start` — bot announces who’s on the clock
6. Managers either:
   - Post `32.5 John Doe LW, ANA`, or
   - Use `/draft-player` and select from autocomplete
7. On timeout the pick is **skipped**; that manager can later post their `Rd.pick …` to catch up without blocking the current clock
8. `/draft-export` when done

## Snake ordering

With `snake: true` and `startRound: 32`:

- Round 32: teams 1→32  
- Round 33: teams 32→1  
- Round 34: teams 1→32  
- …

`pick` in `Rd.pick` is the **slot within that round’s order** (1–32), not overall pick number.

## Troubleshooting

- **Slash commands missing** — set `GUILD_ID` and re-run `npm run register-commands`
- **Picks ignored** — confirm Message Content Intent, correct draft channel, draft status is `running`
- **Player not found** — POS/TEAM must match CSV; use `/draft-pool search`
- **Cannot fill slot** — not your turn and no open skip for that `Rd.pick`

## License

Private / local use. Not published.
