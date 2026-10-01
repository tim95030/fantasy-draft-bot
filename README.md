# Fantasy Draft Bot

A Discord bot that runs a **fantasy sports draft** in a text channel. Built for leagues with about **32 teams** and a large player pool (~**7,000** players with Fantrax IDs).

It supports:

- Snake or linear draft order
- Starting mid-draft (e.g. round 32+)
- A pick timer, skipped picks, and catch-up
- Searching / drafting players with `/draft-player`
- Reading picks posted as: `32.5 John Doe LW, ANA`

---

## Running on Oracle Cloud (recommended if your home PC blocks Discord)

See **[deploy/ORACLE.md](deploy/ORACLE.md)** for Always Free VM setup: create instance, install Node, systemd, and upload player CSV.

## Sleep hours (overnight timer pause)

Admins can pause the **pick countdown** overnight while still allowing picks:

```text
/draft-sleep set start:22:00 end:08:00 timezone:America/Los_Angeles enabled:True
/draft-sleep status
/draft-sleep disable
```

- Times are **24-hour `HH:MM`** in the given **IANA timezone** (shown in status/announcements)
- Windows may cross midnight (e.g. 22:00 → 08:00)
- Remaining time on the clock is preserved and resumes when sleep ends
- Manual `/draft-pause` is separate (pauses the whole draft clock intentionally)

## Pick-clock warnings

Admins can re-announce who’s up as time runs out (any number of thresholds):

```text
/draft-warnings add seconds:60
/draft-warnings add seconds:30
/draft-warnings list
/draft-warnings remove seconds:30
/draft-warnings clear
```

Each warning must be **less than** `/draft-setup` `seconds_per_pick`. When the clock hits that many seconds remaining, the bot re-posts the on-clock ping + embed.

## Draft teams (names + co-owners)

Team count is **not** fixed at 32 anymore.

```text
/draft-setup allow_duplicate_owners:True team_count:4
/draft-order size count:4
/draft-order edit slot:1 team_name:Thunder owners:@alice @bob
/draft-order edit slot:2 team_name:Lightning owners:@carol
/draft-order show
```

- **`allow_duplicate_owners`** — same Discord user can own multiple slots (useful for solo testing)
- **Co-owners** — any listed owner can pick when that team is on the clock (or claim that team’s skips)
- **CSV import** (`/draft-order set` attachment):

```csv
teamName,ownerDiscordIds
Thunder,111111111111111111;222222222222222222
Lightning,333333333333333333
```

Or one owner per row with a shared team name/slot:

```csv
slot,teamName,discordUserId
1,Thunder,111111111111111111
1,Thunder,222222222222222222
2,Lightning,333333333333333333
```

Resize only works when the draft is **not** running (`/draft-end` first if needed).

## Absolute beginner guide: run this from scratch

Follow these sections **in order**. You only need to do the Discord Developer Portal steps once.

### 0) What you need on your computer

1. **Node.js 18 or newer**
   - Check: open Terminal and run:
     ```bash
     node -v
     ```
   - If that fails or shows a version below 18, install from [https://nodejs.org](https://nodejs.org) (LTS is fine).
2. This project on your machine:
   ```bash
   cd ~/Code
   git clone https://github.com/tim95030/fantasy-draft-bot.git
   cd fantasy-draft-bot
   npm install
   ```
   If you already have the folder, just `cd` into it and run `npm install`.

### 1) Create a Discord application + bot (get your token)

1. Open the Discord Developer Portal: [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Log in with the **same Discord account** you use in your league server.
3. Click **New Application**.
4. Name it something like `Fantasy Draft Bot` → **Create**.
5. In the left sidebar, click **Bot**.
6. Click **Add Bot** / **Reset Token** if needed, then **Yes, do it!**
7. Under **Token**, click **Reset Token** (or **Copy**) and copy the token.
   - This is your **`DISCORD_TOKEN`**.
   - Treat it like a password. **Never commit it to git or paste it in Discord chat.**
   - If it ever leaks, click **Reset Token** again and update your `.env`.
8. On the same **Bot** page, scroll to **Privileged Gateway Intents** and turn **ON**:
   - **MESSAGE CONTENT INTENT** (required — without this, pick messages are ignored)
   - **SERVER MEMBERS INTENT** (recommended — helps with display names / mentions)
9. Click **Save Changes**.

### 2) Copy your Application (Client) ID

1. In the left sidebar, click **General Information** (sometimes labeled **OAuth2** → overview).
2. Find **Application ID** and click **Copy**.
   - This is your **`CLIENT_ID`**.
   - It is **not** the same as the bot token.

### 3) (Recommended) Copy your Discord Server ID

This makes slash commands appear **immediately** in your league server.

1. In the Discord desktop/web app: **User Settings → Advanced → Developer Mode → ON**
2. Right-click your **server name** (in the server list) → **Copy Server ID**
   - This is your **`GUILD_ID`**.

### 4) Invite the bot to your server

1. In the Developer Portal, open your app → left sidebar **OAuth2** → **URL Generator**.
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, check at least:
   - Read Messages/View Channels
   - Send Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Use Slash Commands  
   (Or temporarily use **Administrator** for testing, then tighten later.)
4. Copy the **Generated URL** at the bottom, open it in your browser, pick your server, and **Authorize**.
5. Confirm the bot appears offline/online in your member list (it will go online after `npm start`).

### 5) Create your secret `.env` file

In the project folder:

```bash
cd ~/Code/fantasy-draft-bot
cp .env.example .env
```

Open `.env` in any text editor and fill it in:

```env
DISCORD_TOKEN=paste_the_bot_token_here
CLIENT_ID=paste_the_application_id_here
GUILD_ID=paste_your_server_id_here
```

Example shape (fake placeholders only — yours will look different):

```env
DISCORD_TOKEN=REPLACE_WITH_BOT_TOKEN_FROM_DEVELOPER_PORTAL
CLIENT_ID=123456789012345678
GUILD_ID=987654321098765432
```

Notes:

- No quotes around the values
- No spaces around `=`
- `.env` is gitignored so it will not be uploaded to GitHub

### 6) Copy starter data files

```bash
cp data/config.sample.json data/config.json
cp data/draft-order.sample.json data/draft-order.json
cp data/players.sample.csv data/players.csv
```

Later you will replace `players.csv` with your real Fantrax export (see [Player CSV format](#playerscsv)).

### 7) Register slash commands

With the bot **not required to be running** yet:

```bash
npm run register-commands
```

You should see something like: `Registered 16 guild commands to ...`

If you skipped `GUILD_ID`, commands are registered **globally** and can take up to ~1 hour to show up. Prefer setting `GUILD_ID`.

### 8) Start the bot

```bash
npm start
```

Success looks like:

```text
Loaded 6 players (4 available).
Logged in as YourBotName#1234
```

Leave this Terminal window open while the draft is running. Stopping the process (`Ctrl+C`) stops the bot.

### 9) First-time setup inside Discord

Do this in the channel where the draft will happen (you need **Manage Server** or to be listed as an admin later).

1. **Configure the draft**
   ```text
   /draft-setup channel:#your-draft-channel start_round:32 total_rounds:10 seconds_per_pick:120 snake:True
   ```
   This also adds **you** as a draft admin.

2. **Set the 32-team draft order** (first-round order, Discord users in pick order):
   ```text
   /draft-order set users:@Manager1 @Manager2 ... @Manager32 snake:True
   ```
   Or attach a CSV with columns `discordUserId,displayName` via the `csv` option.

   Tip: with Developer Mode on, right-click a user → **Copy User ID** for CSV rows.

3. **Import players**
   ```text
   /draft-import-players csv:your-players.csv
   ```
   Mark already-drafted players with `taken=true` in the CSV (or import presets — see below).

4. **Optional: import earlier picks** so the board has history:
   ```text
   /draft-import-presets csv:preset-picks.csv
   ```

5. **Start**
   ```text
   /draft-start
   ```

The bot will ping whoever is on the clock.

### 10) How managers make picks

**Option A — type in the draft channel:**

```text
32.5 John Doe LW, ANA
```

Meaning: round **32**, pick **5**, player **John Doe**, position **LW**, NHL team **ANA**.  
That player is added to the **person who posted**’s roster (or their skipped slot if catching up).

**Option B — slash command with search:**

```text
/draft-player player:doe
```

Type at least 2 characters, pick from the list (`Name — POS, TEAM`), and the bot submits when it’s your turn (or for an open skip you own).

Useful extras:

- `/draft-status` — who’s up, timer, open skips
- `/draft-board` — recent picks
- `/draft-pool search query:mcdavid` — check availability

---

## Day-to-day cheat sheet

```bash
cd ~/Code/fantasy-draft-bot
npm start                 # run the bot (leave this running)
# In another terminal, only when commands changed or first setup:
npm run register-commands
```

In Discord:

| Goal | Command |
|------|---------|
| Configure channel / rounds / timer / admins | `/draft-setup` |
| Show order | `/draft-order show` |
| Set 32-man order | `/draft-order set` |
| Load player pool | `/draft-import-players` |
| Start draft | `/draft-start` |
| Pause / resume | `/draft-pause` `/draft-resume` |
| Pick-clock warnings | `/draft-warnings` |
| Skip current pick | `/draft-skip` |
| Undo last pick | `/draft-undo` |
| Admin force a pick | `/draft-set-pick` |
| Export results | `/draft-export` |
| Search + draft | `/draft-player` |

---

## Environment variables

| Variable | Required | Where it comes from |
|----------|----------|---------------------|
| `DISCORD_TOKEN` | yes | Developer Portal → Bot → Token |
| `CLIENT_ID` | yes | Developer Portal → Application ID |
| `GUILD_ID` | strongly recommended | Right-click server → Copy Server ID |

---

## Data files

Live runtime files under `data/` (`players.csv`, draft state, config, order) are **gitignored**.  
Committed baselines: `players.default.csv` and `*.sample.*`.

### Player pool loading

1. **`data/players.csv`** — live override (gitignored). Used if present.
2. Else **`data/players.default.csv`** — committed baseline; copied to `players.csv` on first boot.
3. Else **`data/players.sample.csv`** — tiny demo fallback.

| Command | Effect |
|---------|--------|
| `/draft-import-players` | Replace live `players.csv` only |
| `/draft-import-players` + `set_as_default:True` | Also write `players.default.csv` (commit that file if you want it in git) |
| `/draft-reset-players` | Discard live overrides; reload from `players.default.csv` |

### `players.csv` / `players.default.csv` format

```csv
fantraxId,name,position,team,taken
FX001,Connor McDavid,C,EDM,true
FX003,John Doe,LW,ANA,false
```

| Column | Meaning |
|--------|---------|
| `fantraxId` | Unique ID (autocomplete uses this) |
| `name` | Player name |
| `position` | e.g. `C`, `LW`, `D`, `G` |
| `team` | Real NHL/club abbreviation (for identity), **not** the fantasy team |
| `taken` | `true` if already drafted before you start the bot |

### `draft-order.json`

Exactly **32** managers:

```json
{
  "snake": true,
  "teams": [
    { "discordUserId": "123456789012345678", "displayName": "Alice" }
  ]
}
```

### `config.json`

Usually edited via `/draft-setup`:

- `adminUserIds` — draft admins (Manage Server also counts)
- `draftChannelId` — only this channel accepts typed picks
- `startRound`, `totalRounds`, `secondsPerPick`, `snake`

### `preset-picks.csv` (optional)

Applied when you run `/draft-start`:

```csv
round,pick,fantraxId,drafterDiscordUserId
1,1,FX001,123456789012345678
```

### `draft-state.json`

Created automatically (clock, picks, skips). Delete only if you want a hard reset, then `/draft-start` again.

---

## Pick format and skip rules

```text
{round}.{pick} {Player Name} {POS}, {TEAM}
```

Example: `32.5 John Doe LW, ANA`

1. It must be your turn **or** you must own that slot as an open **skip**
2. Player must match the pool (name + POS + team) and not be taken
3. If the name is ambiguous, the bot lists candidates (with Fantrax IDs)

When the timer expires, the pick is **skipped** (not voided). That manager can later post their `Rd.pick …` line to catch up without stopping the current clock.

---

## Commands reference

### Admin

| Command | Purpose |
|---------|---------|
| `/draft-setup` | Channel, start round, rounds left, timer, snake, admins |
| `/draft-order show` / `set` | View or set the 32-team order |
| `/draft-import-players` | Replace player pool CSV (`set_as_default` optional) |
| `/draft-reset-players` | Reload pool from `players.default.csv` |
| `/draft-import-presets` | Save preset picks for next start |
| `/draft-start` | Build queue from start round and go live |
| `/draft-pause` / `/draft-resume` | Pause/resume clock |
| `/draft-warnings` | Add / list / remove / clear pick-clock warnings |
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
- `post_only: true` only posts the formatted line

---

## Snake ordering

With `snake: true` and `startRound: 32`:

- Round 32: teams 1→32
- Round 33: teams 32→1
- Round 34: teams 1→32
- …

`pick` in `Rd.pick` is the slot **within that round** (1–32), not the overall pick number across all rounds.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing DISCORD_TOKEN` | Create `.env` from `.env.example` and paste the bot token |
| Bot online but slash commands missing | Set `GUILD_ID`, run `npm run register-commands`, wait a minute, restart Discord client |
| Typed picks ignored | Enable **Message Content Intent**, confirm `/draft-setup` channel, ensure `/draft-start` was run |
| `Used disallowed intents` | Turn on the privileged intents on the Bot page and save |
| Bot won’t join / can’t see channels | Re-invite with `bot` + `applications.commands` and Send Messages permission |
| Player not found | POS/TEAM must match CSV; try `/draft-pool search` |
| Cannot fill slot | Not your turn and no open skip for that `Rd.pick` |
| Token leaked | Developer Portal → Bot → **Reset Token**, update `.env` |

---

## Security reminders

- Never commit `.env`, tokens, or your real `players.csv` / draft state
- Don’t share your bot token in screenshots or chat
- Prefer a private GitHub repo if you fork with league data (this public repo should only have samples)

---

## License

Use freely for your league. Keep secrets out of git.
