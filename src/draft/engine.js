const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const { loadConfig, updateConfig } = require('../config');
const paths = require('../paths');
const { pool, parseCsv, toCsv } = require('./players');
const {
  loadOrder,
  saveOrder,
  validateOrder,
  buildQueue,
  findTeam,
  slotOwnedBy,
  mentionOwners,
} = require('./order');
const { loadState, saveState, resetState } = require('./state');
const { DraftTimer } = require('./timer');
const { formatPickLine } = require('./parser');
const { formatDuration } = require('./formatDuration');
const {
  isInSleepWindow,
  sleepWindowLabel,
  nextSleepEndDate,
  formatInZone,
} = require('./sleepHours');

class DraftEngine {
  constructor() {
    this.timer = new DraftTimer();
    /** @type {import('discord.js').Client | null} */
    this.client = null;
    this._announcing = false;
  }

  bindClient(client) {
    this.client = client;
  }

  getConfig() {
    return loadConfig();
  }

  getOrder() {
    return loadOrder();
  }

  getState() {
    return loadState();
  }

  persist(state) {
    return saveState(state);
  }

  currentSlot(state = this.getState()) {
    if (!state.queue?.length) return null;
    if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) return null;
    return state.queue[state.currentIndex];
  }

  isFilled(state, round, pick) {
    return state.picks.some((p) => p.round === round && p.pick === pick);
  }

  isSkipped(state, round, pick) {
    return state.skipped.some((s) => s.round === round && s.pick === pick);
  }

  openSkipsForUser(state, discordUserId) {
    const id = String(discordUserId);
    return state.skipped.filter((s) => {
      if (this.isFilled(state, s.round, s.pick)) return false;
      if (Array.isArray(s.ownerIds) && s.ownerIds.map(String).includes(id)) return true;
      return String(s.discordUserId) === id;
    });
  }

  findSkip(state, round, pick) {
    return state.skipped.find((s) => s.round === round && s.pick === pick);
  }

  removeSkip(state, round, pick) {
    state.skipped = state.skipped.filter((s) => !(s.round === round && s.pick === pick));
  }

  advanceToNextOpen(state) {
    while (state.currentIndex < state.queue.length) {
      const slot = state.queue[state.currentIndex];
      if (!this.isFilled(state, slot.round, slot.pick)) return slot;
      state.currentIndex += 1;
    }
    return null;
  }

  async getDraftChannel() {
    const config = this.getConfig();
    if (!this.client || !config.draftChannelId) return null;
    try {
      const ch = await this.client.channels.fetch(config.draftChannelId);
      return ch;
    } catch {
      return null;
    }
  }

  onClockEmbed(slot, state, secondsLeft) {
    const skips = state.skipped.filter((s) => !this.isFilled(state, s.round, s.pick));
    const owners = mentionOwners(slot);
    const config = this.getConfig();
    const sleeping = state.sleepPaused || isInSleepWindow(config);

    let timeValue = secondsLeft != null ? formatDuration(secondsLeft) : '—';
    if (sleeping) {
      const wake = nextSleepEndDate(config);
      const wakeLabel = wake
        ? formatInZone(wake, config.sleepTimezone || 'America/Los_Angeles')
        : sleepWindowLabel(config);
      const rem =
        state.sleepRemainingMs != null
          ? formatDuration(state.sleepRemainingMs / 1000)
          : secondsLeft != null
            ? formatDuration(secondsLeft)
            : formatDuration(config.secondsPerPick);
      timeValue = `⏸ Paused for sleep · ${rem} left · resumes ${wakeLabel}`;
    }

    const embed = new EmbedBuilder()
      .setTitle(sleeping ? 'On the clock (sleep hours)' : 'On the clock')
      .setColor(sleeping ? 0x6e7681 : 0x1f6feb)
      .setDescription(
        `**${slot.round}.${slot.pick}** — **${slot.teamName || slot.displayName}** (${owners})`,
      )
      .addFields(
        {
          name: 'Time remaining',
          value: timeValue,
          inline: false,
        },
        {
          name: 'Progress',
          value: `${state.currentIndex + 1} / ${state.queue.length}`,
          inline: true,
        },
        {
          name: 'Open skips',
          value:
            skips.length === 0
              ? 'None'
              : skips
                  .slice(0, 15)
                  .map(
                    (s) =>
                      `${s.round}.${s.pick} ${s.teamName || s.displayName || ''} ${mentionOwners(s)}`,
                  )
                  .join('\n') + (skips.length > 15 ? `\n…+${skips.length - 15} more` : ''),
        },
      )
      .setFooter({
        text: sleeping
          ? `Picks still allowed. Sleep window: ${sleepWindowLabel(config)}`
          : 'Pick format: Rd.pick Player Name POS, TEAM  e.g. 32.5 John Doe LW, ANA',
      });
    return embed;
  }

  async announceOnClock(state = this.getState()) {
    const slot = this.currentSlot(state);
    const channel = await this.getDraftChannel();
    if (!slot || !channel) return;

    const config = this.getConfig();
    const secondsLeft = state.clockEndsAt
      ? (state.clockEndsAt - Date.now()) / 1000
      : config.secondsPerPick;

    await channel.send({
      content: `${mentionOwners(slot)} — **${slot.teamName || slot.displayName}** is on the clock.`,
      embeds: [this.onClockEmbed(slot, state, secondsLeft)],
    });
  }

  startClock(state, { remainingMs = null } = {}) {
    const config = this.getConfig();
    if (state.status !== 'running') return;

    const slot = this.advanceToNextOpen(state);
    if (!slot) {
      state.status = 'ended';
      state.clockEndsAt = null;
      state.sleepPaused = false;
      state.sleepRemainingMs = null;
      this.timer.clear();
      this.persist(state);
      this.getDraftChannel().then((ch) => ch?.send('Draft complete — all slots filled.'));
      return;
    }

    const fullMs = Math.max(1, config.secondsPerPick) * 1000;
    const ms =
      remainingMs != null && remainingMs > 0 ? remainingMs : fullMs;

    // Quiet hours: keep picks open, but do not run the countdown
    if (isInSleepWindow(config)) {
      this.timer.clear();
      state.sleepPaused = true;
      state.sleepRemainingMs = ms;
      state.clockEndsAt = null;
      this.persist(state);
      return;
    }

    state.sleepPaused = false;
    state.sleepRemainingMs = null;
    state.clockEndsAt = Date.now() + ms;
    this.persist(state);

    this.timer.start(ms, async () => {
      await this.handleTimeout();
    });
  }

  async handleTimeout() {
    const state = this.getState();
    if (state.status !== 'running') return;

    // Safety: never skip during sleep hours
    if (isInSleepWindow(this.getConfig())) {
      const remaining = state.clockEndsAt
        ? Math.max(0, state.clockEndsAt - Date.now())
        : state.sleepRemainingMs || this.getConfig().secondsPerPick * 1000;
      await this.enterSleepMode(state, remaining);
      return;
    }

    const slot = this.currentSlot(state);
    if (!slot) return;
    if (this.isFilled(state, slot.round, slot.pick)) {
      this.startClock(state);
      await this.announceOnClock(state);
      return;
    }

    if (!this.isSkipped(state, slot.round, slot.pick)) {
      state.skipped.push({
        round: slot.round,
        pick: slot.pick,
        discordUserId: slot.discordUserId,
        ownerIds: slot.ownerIds || [slot.discordUserId],
        teamName: slot.teamName || slot.displayName,
        displayName: slot.displayName,
        overallIndex: slot.overallIndex,
        skippedAt: new Date().toISOString(),
      });
    }

    const channel = await this.getDraftChannel();
    if (channel) {
      await channel.send(
        `Time expired — **${slot.round}.${slot.pick}** for **${slot.teamName || slot.displayName}** (${mentionOwners(slot)}) marked **skipped**. They can still claim it later.`,
      );
    }

    state.currentIndex += 1;
    this.persist(state);
    this.startClock(state);
    await this.announceOnClock(state);
  }

  /**
   * Seed taken players + optional preset picks into state before start.
   */
  applyPresets(state, presetRows) {
    for (const row of presetRows) {
      const fantraxId = String(row.fantraxId).trim();
      const player = pool.get(fantraxId);
      if (!player) throw new Error(`Unknown fantraxId in presets: ${fantraxId}`);
      pool.markTaken(fantraxId, true);

      const round = Number(row.round);
      const pick = Number(row.pick);
      const discordUserId = String(row.drafterDiscordUserId);
      if (this.isFilled(state, round, pick)) continue;

      state.picks.push({
        round,
        pick,
        fantraxId,
        playerName: player.name,
        position: player.position,
        team: player.team,
        discordUserId,
        displayName: findTeam(this.getOrder(), discordUserId)?.displayName || discordUserId,
        at: new Date().toISOString(),
        source: 'preset',
      });
    }
  }

  loadPresetFile(filePath = paths.PRESET_CSV) {
    if (!fs.existsSync(filePath)) return [];
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const idx = {
      round: header.indexOf('round'),
      pick: header.indexOf('pick'),
      fantraxId: header.findIndex((h) => h === 'fantraxid' || h === 'id'),
      drafterDiscordUserId: header.findIndex(
        (h) => h === 'drafterdiscorduserid' || h === 'discorduserid' || h === 'userid',
      ),
    };
    if (idx.round < 0 || idx.pick < 0 || idx.fantraxId < 0 || idx.drafterDiscordUserId < 0) {
      throw new Error(
        'preset-picks.csv needs columns: round,pick,fantraxId,drafterDiscordUserId',
      );
    }
    return rows.slice(1).map((r) => ({
      round: r[idx.round],
      pick: r[idx.pick],
      fantraxId: r[idx.fantraxId],
      drafterDiscordUserId: r[idx.drafterDiscordUserId],
    }));
  }

  startDraft({ announce = true } = {}) {
    const config = this.getConfig();
    const order = this.getOrder();
    const err = validateOrder(order, {
      allowDuplicateOwners: order.allowDuplicateOwners || config.allowDuplicateOwners,
    });
    if (err) throw new Error(err);
    if (!config.draftChannelId) throw new Error('Set a draft channel with /draft-setup first.');
    if (pool.size === 0) throw new Error('Load players first (/draft-import-players).');

    const queue = buildQueue({
      teams: order.teams,
      snake: config.snake ?? order.snake,
      startRound: config.startRound,
      totalRounds: config.totalRounds,
    });

    const state = resetState();
    state.status = 'running';
    state.startedAt = new Date().toISOString();
    state.queue = queue;
    state.currentIndex = 0;

    // Ensure CSV "taken" flags are reflected
    for (const p of pool.byId.values()) {
      // already in memory
    }

    try {
      const presets = this.loadPresetFile();
      this.applyPresets(state, presets);
    } catch (e) {
      // If no presets file that's fine; rethrow real parse errors only when file exists
      if (fs.existsSync(paths.PRESET_CSV)) throw e;
    }

    this.advanceToNextOpen(state);
    this.persist(state);
    pool.saveToFile();
    this.startClock(state);

    if (announce) {
      return this.announceOnClock(state).then(() => state);
    }
    return state;
  }

  pause() {
    const state = this.getState();
    if (state.status !== 'running') throw new Error('Draft is not running.');
    state.status = 'paused';
    state.pausedAt = new Date().toISOString();
    this.timer.clear();
    this.persist(state);
    return state;
  }

  resume() {
    const state = this.getState();
    if (state.status !== 'paused') throw new Error('Draft is not paused.');
    state.status = 'running';
    state.pausedAt = null;
    this.persist(state);
    this.startClock(state);
    return this.announceOnClock(state).then(() => state);
  }

  end() {
    const state = this.getState();
    state.status = 'ended';
    state.clockEndsAt = null;
    this.timer.clear();
    this.persist(state);
    pool.saveToFile();
    return state;
  }

  forceSkip() {
    const state = this.getState();
    if (state.status !== 'running' && state.status !== 'paused') {
      throw new Error('No active draft.');
    }
    const slot = this.currentSlot(state);
    if (!slot) throw new Error('No current slot.');
    if (this.isFilled(state, slot.round, slot.pick)) throw new Error('Current slot already filled.');

    if (!this.isSkipped(state, slot.round, slot.pick)) {
      state.skipped.push({
        round: slot.round,
        pick: slot.pick,
        discordUserId: slot.discordUserId,
        ownerIds: slot.ownerIds || [slot.discordUserId],
        teamName: slot.teamName || slot.displayName,
        displayName: slot.displayName,
        overallIndex: slot.overallIndex,
        skippedAt: new Date().toISOString(),
      });
    }
    state.currentIndex += 1;
    this.persist(state);
    if (state.status === 'running') this.startClock(state);
    return { state, slot };
  }

  /**
   * Resolve a pick attempt from a Discord user.
   */
  submitPick({
    discordUserId,
    fantraxId,
    round,
    pick,
    adminOverride = false,
    source = 'message',
  }) {
    const state = this.getState();
    if (state.status !== 'running' && state.status !== 'paused' && !adminOverride) {
      throw new Error('Draft is not active.');
    }

    const player = pool.get(fantraxId);
    if (!player) throw new Error(`Unknown player id: ${fantraxId}`);
    if (player.taken) throw new Error(`${player.name} is already drafted.`);

    const order = this.getOrder();
    const manager = findTeam(order, discordUserId);
    if (!manager && !adminOverride) {
      throw new Error('You are not an owner of any draft team.');
    }

    const current = this.currentSlot(state);
    let targetSlot = null;
    let isCatchUp = false;

    if (round != null && pick != null) {
      targetSlot = state.queue.find((s) => s.round === round && s.pick === pick);
      if (!targetSlot) throw new Error(`Slot ${round}.${pick} is not in this draft window.`);
      if (this.isFilled(state, round, pick)) {
        throw new Error(`${round}.${pick} is already filled.`);
      }

      const ownsSlot = slotOwnedBy(targetSlot, discordUserId);
      const isCurrent =
        current && current.round === round && current.pick === pick && ownsSlot;
      const skip = this.findSkip(state, round, pick);
      const skippedOwned =
        Boolean(skip) &&
        (slotOwnedBy(skip, discordUserId) ||
          (Array.isArray(skip.ownerIds)
            ? skip.ownerIds.map(String).includes(String(discordUserId))
            : String(skip.discordUserId) === String(discordUserId)));

      if (!adminOverride && !isCurrent && !skippedOwned) {
        throw new Error(
          `You cannot fill ${round}.${pick}. Wait for your team's turn or claim one of your skipped picks.`,
        );
      }
      isCatchUp = Boolean(skippedOwned && !isCurrent);
    } else {
      // No explicit slot: current turn (if this user owns it), else earliest open skip
      if (
        current &&
        slotOwnedBy(current, discordUserId) &&
        !this.isFilled(state, current.round, current.pick)
      ) {
        targetSlot = current;
      } else {
        const skips = this.openSkipsForUser(state, discordUserId);
        if (!skips.length && !adminOverride) {
          throw new Error("It is not your team's turn and you have no open skipped picks.");
        }
        if (skips.length) {
          const s = skips[0];
          targetSlot = state.queue.find((q) => q.round === s.round && q.pick === s.pick);
          isCatchUp = true;
        } else {
          throw new Error('No target slot.');
        }
      }
    }

    if (adminOverride && round != null && pick != null) {
      targetSlot = state.queue.find((s) => s.round === round && s.pick === pick) || targetSlot;
      if (!targetSlot) throw new Error(`Slot ${round}.${pick} not found.`);
    }

    const pickRecord = {
      round: targetSlot.round,
      pick: targetSlot.pick,
      fantraxId: player.fantraxId,
      playerName: player.name,
      position: player.position,
      team: player.team,
      discordUserId: String(discordUserId),
      ownerIds: targetSlot.ownerIds || [targetSlot.discordUserId],
      teamName: targetSlot.teamName || targetSlot.displayName,
      displayName: targetSlot.teamName || targetSlot.displayName,
      at: new Date().toISOString(),
      source,
      catchUp: isCatchUp,
    };

    state.picks.push(pickRecord);
    this.removeSkip(state, pickRecord.round, pickRecord.pick);
    pool.markTaken(player.fantraxId, true);
    pool.saveToFile();

    const wasCurrent =
      current &&
      current.round === pickRecord.round &&
      current.pick === pickRecord.pick;

    if (wasCurrent) {
      state.currentIndex += 1;
      this.persist(state);
      if (state.status === 'running') this.startClock(state);
    } else {
      this.persist(state);
    }

    return {
      pickRecord,
      player,
      line: formatPickLine(
        pickRecord.round,
        pickRecord.pick,
        player.name,
        player.position,
        player.team,
      ),
      wasCurrent,
      state: this.getState(),
    };
  }

  /**
   * Replace an existing pick with an available player.
   * Old player returns to the available pool.
   */
  replacePick({
    discordUserId,
    round,
    pick,
    newFantraxId,
    adminOverride = false,
  }) {
    const state = this.getState();
    if (state.status !== 'running' && state.status !== 'paused' && state.status !== 'ended') {
      throw new Error('No draft picks to edit yet.');
    }

    const existing = state.picks.find((p) => p.round === round && p.pick === pick);
    if (!existing) {
      throw new Error(`No recorded pick at ${round}.${pick}.`);
    }

    const owns =
      slotOwnedBy(existing, discordUserId) ||
      (Array.isArray(existing.ownerIds) &&
        existing.ownerIds.map(String).includes(String(discordUserId))) ||
      String(existing.discordUserId) === String(discordUserId);

    if (!adminOverride && !owns) {
      throw new Error(`You can only edit picks for your own team (${existing.teamName || 'unknown'}).`);
    }

    const newPlayer = pool.get(newFantraxId);
    if (!newPlayer) throw new Error(`Unknown player id: ${newFantraxId}`);
    if (newPlayer.taken && newPlayer.fantraxId !== existing.fantraxId) {
      throw new Error(`${newPlayer.name} is already drafted.`);
    }
    if (newPlayer.fantraxId === existing.fantraxId) {
      throw new Error('That player is already in this slot.');
    }

    const oldPlayer = pool.get(existing.fantraxId);
    const previous = { ...existing };

    if (oldPlayer) pool.markTaken(oldPlayer.fantraxId, false);
    pool.markTaken(newPlayer.fantraxId, true);
    pool.saveToFile();

    existing.fantraxId = newPlayer.fantraxId;
    existing.playerName = newPlayer.name;
    existing.position = newPlayer.position;
    existing.team = newPlayer.team;
    existing.at = new Date().toISOString();
    existing.source = 'edit';
    existing.editedBy = String(discordUserId);
    existing.replacedFantraxId = previous.fantraxId;

    this.persist(state);

    return {
      previous,
      pickRecord: existing,
      newPlayer,
      oldPlayer,
      line: formatPickLine(
        existing.round,
        existing.pick,
        newPlayer.name,
        newPlayer.position,
        newPlayer.team,
      ),
      state: this.getState(),
    };
  }

  undoLast() {
    const state = this.getState();
    if (!state.picks.length) throw new Error('No picks to undo.');
    const last = state.picks.pop();
    pool.markTaken(last.fantraxId, false);
    pool.saveToFile();

    // If we undid the slot at or before current, move pointer back to that slot if it is earlier
    const idx = state.queue.findIndex((s) => s.round === last.round && s.pick === last.pick);
    if (idx >= 0 && idx <= state.currentIndex) {
      state.currentIndex = idx;
    }

    this.persist(state);
    if (state.status === 'running') this.startClock(state);
    return last;
  }

  statusSummary() {
    const state = this.getState();
    const config = this.getConfig();
    const slot = this.currentSlot(state);
    const sleeping = Boolean(state.sleepPaused) || isInSleepWindow(config);
    let secondsLeft = null;
    if (sleeping && state.sleepRemainingMs != null) {
      secondsLeft = Math.max(0, Math.ceil(state.sleepRemainingMs / 1000));
    } else if (state.clockEndsAt) {
      secondsLeft = Math.max(0, Math.ceil((state.clockEndsAt - Date.now()) / 1000));
    }
    const openSkips = state.skipped.filter((s) => !this.isFilled(state, s.round, s.pick));
    const wakeAt = sleeping ? nextSleepEndDate(config) : null;
    return {
      state,
      config,
      slot,
      secondsLeft,
      openSkips,
      sleeping,
      sleepLabel: sleepWindowLabel(config),
      wakeLabel: wakeAt
        ? formatInZone(wakeAt, config.sleepTimezone || 'America/Los_Angeles')
        : null,
    };
  }

  /**
   * Pause the pick clock for quiet hours; picks remain allowed.
   */
  async enterSleepMode(state = this.getState(), remainingMs = null) {
    if (state.status !== 'running') return state;

    let rem = remainingMs;
    if (rem == null) {
      if (state.clockEndsAt) rem = Math.max(0, state.clockEndsAt - Date.now());
      else if (state.sleepRemainingMs != null) rem = state.sleepRemainingMs;
      else rem = this.getConfig().secondsPerPick * 1000;
    }

    const already = state.sleepPaused && state.clockEndsAt == null;
    this.timer.clear();
    state.sleepPaused = true;
    state.sleepRemainingMs = rem;
    state.clockEndsAt = null;
    this.persist(state);

    if (!already) {
      const config = this.getConfig();
      const wake = nextSleepEndDate(config);
      const channel = await this.getDraftChannel();
      if (channel) {
        await channel.send(
          `🌙 **Sleep hours** — pick timer paused (${formatDuration(rem / 1000)} left on the clock). ` +
            `Picks are still allowed. Timer resumes **${
              wake
                ? formatInZone(wake, config.sleepTimezone || 'America/Los_Angeles')
                : sleepWindowLabel(config)
            }**.`,
        );
      }
    }
    return state;
  }

  async exitSleepMode(state = this.getState()) {
    if (state.status !== 'running') return state;
    if (!state.sleepPaused && !isInSleepWindow(this.getConfig())) {
      // nothing to do
    }

    const rem = state.sleepRemainingMs;
    state.sleepPaused = false;
    state.sleepRemainingMs = null;
    this.persist(state);

    const channel = await this.getDraftChannel();
    if (channel) {
      await channel.send(
        `☀️ **Sleep hours over** — pick timer resumed` +
          (rem != null ? ` (${formatDuration(rem / 1000)} left).` : '.'),
      );
    }

    this.startClock(state, { remainingMs: rem });
    await this.announceOnClock(this.getState());
    return this.getState();
  }

  /**
   * Called periodically to enter/exit sleep based on configured hours.
   */
  async checkSleepTransition() {
    const state = this.getState();
    if (state.status !== 'running') return;

    const config = this.getConfig();
    const shouldSleep = isInSleepWindow(config);

    if (shouldSleep && !state.sleepPaused) {
      await this.enterSleepMode(state);
    } else if (!shouldSleep && state.sleepPaused) {
      await this.exitSleepMode(state);
    }
  }

  startSleepWatcher(intervalMs = 30_000) {
    if (this._sleepWatcher) clearInterval(this._sleepWatcher);
    this._sleepWatcher = setInterval(() => {
      this.checkSleepTransition().catch((err) =>
        console.error('Sleep transition check failed:', err),
      );
    }, intervalMs);
    if (typeof this._sleepWatcher.unref === 'function') this._sleepWatcher.unref();
    // Run once immediately
    this.checkSleepTransition().catch(() => {});
  }

  exportPicksCsv() {
    const state = this.getState();
    const rows = [
      [
        'round',
        'pick',
        'fantraxId',
        'playerName',
        'position',
        'team',
        'drafterDiscordUserId',
        'displayName',
        'at',
        'source',
      ],
    ];
    for (const p of state.picks) {
      rows.push([
        p.round,
        p.pick,
        p.fantraxId,
        p.playerName,
        p.position,
        p.team,
        p.discordUserId,
        p.displayName,
        p.at,
        p.source,
      ]);
    }
    return `${toCsv(rows)}\n`;
  }

  resumeTimerIfNeeded() {
    const state = this.getState();
    if (state.status !== 'running') return;

    if (isInSleepWindow(this.getConfig())) {
      const rem = state.clockEndsAt
        ? Math.max(0, state.clockEndsAt - Date.now())
        : state.sleepRemainingMs;
      this.enterSleepMode(state, rem);
      return;
    }

    if (state.sleepPaused) {
      this.exitSleepMode(state);
      return;
    }

    const remaining = state.clockEndsAt ? state.clockEndsAt - Date.now() : 0;
    if (remaining <= 0) {
      this.handleTimeout();
    } else {
      this.timer.start(remaining, async () => {
        await this.handleTimeout();
      });
    }
  }
}

const engine = new DraftEngine();

module.exports = {
  DraftEngine,
  engine,
  updateConfig,
  saveOrder,
  loadOrder,
  validateOrder,
};
