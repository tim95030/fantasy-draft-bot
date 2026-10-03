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
  applyLiveTeam,
} = require('./order');
const { loadState, saveState, resetState } = require('./state');
const { DraftTimer } = require('./timer');
const { formatPickLine } = require('./parser');
const { formatDuration } = require('./formatDuration');
const playerQueue = require('./playerQueue');
const { audit } = require('./audit');
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

  /**
   * Re-apply live draft-order team names/owners onto the running queue,
   * skips, and picks. Fixes renames (Sharks → San Jose Sharks) mid-draft.
   */
  syncTeamsFromOrder(state = this.getState()) {
    if (
      state.status !== 'running' &&
      state.status !== 'paused' &&
      state.status !== 'ended'
    ) {
      return false;
    }
    const order = this.getOrder();
    const config = this.getConfig();
    const opts = {
      snake: config.snake ?? order.snake,
      startRound: config.startRound,
    };
    let changed = false;
    for (const slot of state.queue || []) {
      if (applyLiveTeam(slot, order, opts)) changed = true;
    }
    for (const slot of state.skipped || []) {
      if (applyLiveTeam(slot, order, opts)) changed = true;
    }
    for (const pick of state.picks || []) {
      if (applyLiveTeam(pick, order, opts)) changed = true;
    }
    if (changed) this.persist(state);
    return changed;
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

  /**
   * Open skips already on this fantasy team, excluding the on-clock slot.
   */
  sameTeamOpenSkipCount(state, slot) {
    if (!slot || !Array.isArray(state.skipped)) return 0;
    const teamIndex =
      Number.isInteger(slot.teamIndex) && slot.teamIndex >= 0 ? Number(slot.teamIndex) : null;
    const owners = new Set(
      [
        ...(Array.isArray(slot.ownerIds) ? slot.ownerIds.map(String) : []),
        slot.discordUserId != null ? String(slot.discordUserId) : '',
      ].filter(Boolean),
    );
    return state.skipped.filter((s) => {
      if (this.isFilled(state, s.round, s.pick)) return false;
      if (Number(s.round) === Number(slot.round) && Number(s.pick) === Number(slot.pick)) {
        return false;
      }
      if (teamIndex != null && Number.isInteger(s.teamIndex)) {
        return Number(s.teamIndex) === teamIndex;
      }
      const skipOwners = [
        ...(Array.isArray(s.ownerIds) ? s.ownerIds.map(String) : []),
        s.discordUserId != null ? String(s.discordUserId) : '',
      ];
      return skipOwners.some((id) => owners.has(id));
    }).length;
  }

  clockMsForSlot(state, slot, remainingMs = null) {
    const config = this.getConfig();
    const fullMs = Math.max(1, config.secondsPerPick) * 1000;
    if (remainingMs != null && remainingMs > 0) return remainingMs;
    if (config.skipAccelEnabled && this.sameTeamOpenSkipCount(state, slot) >= 1) {
      return Math.max(1000, Math.floor(fullMs / 4));
    }
    return fullMs;
  }

  pushSkipRecord(state, slot) {
    if (this.isSkipped(state, slot.round, slot.pick)) return;
    state.skipped.push({
      round: slot.round,
      pick: slot.pick,
      discordUserId: slot.discordUserId,
      ownerIds: slot.ownerIds || [slot.discordUserId],
      teamIndex: slot.teamIndex,
      teamName: slot.teamName || slot.displayName,
      displayName: slot.displayName,
      overallIndex: slot.overallIndex,
      skippedAt: new Date().toISOString(),
    });
  }

  openSkipsForUser(state, discordUserId) {
    const id = String(discordUserId);
    return state.skipped
      .filter((s) => {
        if (this.isFilled(state, s.round, s.pick)) return false;
        if (Array.isArray(s.ownerIds) && s.ownerIds.map(String).includes(id)) return true;
        return String(s.discordUserId) === id;
      })
      .sort((a, b) => this.slotSortKey(a) - this.slotSortKey(b));
  }

  slotSortKey(slot) {
    if (slot == null) return Number.POSITIVE_INFINITY;
    if (Number.isInteger(slot.overallIndex)) return slot.overallIndex;
    return Number(slot.round) * 1000 + Number(slot.pick);
  }

  /**
   * Oldest claimable slot for a Discord user: earliest open skip, else
   * the on-clock slot if they own it. Skips always beat the active clock.
   */
  oldestOpenSlotForUser(state, discordUserId) {
    const skips = this.openSkipsForUser(state, discordUserId);
    if (skips.length) return skips[0];
    const current = this.currentSlot(state);
    if (
      current &&
      slotOwnedBy(current, discordUserId) &&
      !this.isFilled(state, current.round, current.pick)
    ) {
      return current;
    }
    return null;
  }

  /**
   * Oldest claimable slot for a fantasy team (by name / draft-order index).
   * Open skips first (earliest), else on-clock if that team is up.
   */
  oldestOpenSlotForTeam(state, team, teamIndex = null) {
    const name = String(team?.teamName || '')
      .trim()
      .toLowerCase();
    const match = (slot) => {
      if (!slot) return false;
      if (
        teamIndex != null &&
        Number.isInteger(slot.teamIndex) &&
        Number(slot.teamIndex) === Number(teamIndex)
      ) {
        return true;
      }
      const slotName = String(slot.teamName || slot.displayName || '')
        .trim()
        .toLowerCase();
      return Boolean(name && slotName && name === slotName);
    };

    const skips = state.skipped
      .filter((s) => !this.isFilled(state, s.round, s.pick) && match(s))
      .sort((a, b) => this.slotSortKey(a) - this.slotSortKey(b));
    if (skips.length) return skips[0];

    const current = this.currentSlot(state);
    if (current && match(current) && !this.isFilled(state, current.round, current.pick)) {
      return current;
    }
    return null;
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

    const endRound =
      state.queue.length > 0
        ? state.queue[state.queue.length - 1].round
        : config.startRound + config.totalRounds - 1;
    const picksThisRound = state.queue.filter((s) => s.round === slot.round).length;
    const overallPick = state.currentIndex + 1;
    const overallTotal = state.queue.length;

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
          value: [
            `Round **${slot.round}** of **${endRound}**`,
            `Pick **${slot.pick}** of **${picksThisRound}** this round`,
            `Pick **${overallPick}** of **${overallTotal}** overall`,
          ].join('\n'),
          inline: false,
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
        {
          name: 'How to pick',
          value: 'Use `/draft-player` (autocomplete)',
          inline: false,
        },
      )
      .setFooter({
        text: sleeping
          ? `Picks still allowed. Sleep window: ${sleepWindowLabel(config)}`
          : 'Search with /draft-player to submit your pick',
      });
    return embed;
  }

  async announceOnClock(state = this.getState()) {
    this.syncTeamsFromOrder(state);
    const slot = this.currentSlot(state);
    const channel = await this.getDraftChannel();
    if (!slot || !channel) return;

    const config = this.getConfig();
    const secondsLeft = state.clockEndsAt
      ? (state.clockEndsAt - Date.now()) / 1000
      : state.sleepRemainingMs != null
        ? state.sleepRemainingMs / 1000
        : this.clockMsForSlot(state, slot) / 1000;

    const shortClock =
      config.skipAccelEnabled && this.sameTeamOpenSkipCount(state, slot) >= 1;
    await channel.send({
      content:
        `${mentionOwners(slot)} — **${slot.teamName || slot.displayName}** is on the clock.` +
        (shortClock ? ' _(short clock — already has a skip)_' : ''),
      embeds: [this.onClockEmbed(slot, state, secondsLeft)],
    });
  }

  async announceWarning(secondsLeft) {
    const state = this.getState();
    if (state.status !== 'running') return;
    if (isInSleepWindow(this.getConfig())) return;

    this.syncTeamsFromOrder(state);
    const slot = this.currentSlot(state);
    if (!slot || this.isFilled(state, slot.round, slot.pick)) return;

    const channel = await this.getDraftChannel();
    if (!channel) return;

    const left = formatDuration(secondsLeft);
    await channel.send({
      content:
        `⏰ **${left} left** — ${mentionOwners(slot)} — **${slot.teamName || slot.displayName}** still on the clock.`,
      embeds: [this.onClockEmbed(slot, state, secondsLeft)],
    });
  }

  /** Update warning timers for the active pick without touching the expire deadline. */
  refreshWarnings() {
    const state = this.getState();
    if (state.status !== 'running' || state.sleepPaused) return false;
    if (state.clockEndsAt == null) return false;
    const config = this.getConfig();
    return this.timer.refreshWarnings(config.pickWarningsSec || [], async (secondsLeft) => {
      await this.announceWarning(secondsLeft);
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

    const ms = this.clockMsForSlot(state, slot, remainingMs);

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

    this.timer.start(
      ms,
      async () => {
        await this.handleTimeout();
      },
      {
        warningsSec: config.pickWarningsSec || [],
        onWarning: async (secondsLeft) => {
          await this.announceWarning(secondsLeft);
        },
      },
    );
  }

  /**
   * After a human pick/skip (or at draft start): run autodrafts in order with
   * awaited announcements, then start the human clock and announce who's up.
   * Callers that post a "Recorded …" line should await that message first.
   */
  async proceedToNextPick({ remainingMs = null, announce = true } = {}) {
    while (true) {
      // Always reload — submitPick persists a fresh copy; looping on a stale
      // object re-targets the same slot and burns queue entries.
      const state = this.getState();
      if (state.status !== 'running') return state;

      const indexBefore = state.currentIndex;
      const slot = this.advanceToNextOpen(state);
      if (state.currentIndex !== indexBefore) this.persist(state);

      if (!slot) {
        state.status = 'ended';
        state.clockEndsAt = null;
        state.sleepPaused = false;
        state.sleepRemainingMs = null;
        this.timer.clear();
        this.persist(state);
        const channel = await this.getDraftChannel();
        if (channel) await channel.send('Draft complete — all slots filled.');
        return this.getState();
      }

      const autoResult = this.tryAutoDraftOnce(slot);
      if (autoResult) {
        await this.announceAutodraft(autoResult);
        continue;
      }

      const config = this.getConfig();
      if (config.skipAccelEnabled) {
        const live = this.getState();
        const current = this.currentSlot(live) || slot;
        const openSkips = this.sameTeamOpenSkipCount(live, current);
        if (openSkips >= 2) {
          await this.skipForRepeatInactivity(live, current, openSkips);
          continue;
        }
      }
      break;
    }

    this.startClock(this.getState(), { remainingMs });
    if (announce && this.getState().status === 'running') {
      await this.announceOnClock(this.getState());
    }
    return this.getState();
  }

  /**
   * If the on-clock team has autodraft enabled, submit the first available
   * queued player. Returns the submitPick result, or null.
   * Does not start the clock — caller runs proceedToNextPick / startClock.
   */
  tryAutoDraftOnce(slot) {
    if (!slot || slot.teamIndex == null || slot.teamIndex < 0) return null;

    const entry = playerQueue.getEntry(slot.teamIndex);
    if (!entry.autoDraft) return null;

    const drafterId = String(
      slot.discordUserId ||
        (Array.isArray(slot.ownerIds) && slot.ownerIds[0]) ||
        '',
    );
    if (!drafterId) {
      audit('autodraft.skip', {
        reason: 'no_owner',
        teamIndex: slot.teamIndex,
        round: slot.round,
        pick: slot.pick,
      });
      return null;
    }

    while (true) {
      const live = this.getState();
      if (this.isFilled(live, slot.round, slot.pick)) {
        audit('autodraft.skip', {
          reason: 'already_filled',
          teamIndex: slot.teamIndex,
          round: slot.round,
          pick: slot.pick,
        });
        return null;
      }

      const fantraxId = playerQueue.peekNextAvailable(slot.teamIndex, pool);
      if (!fantraxId) {
        audit('autodraft.skip', {
          reason: 'empty_queue',
          teamIndex: slot.teamIndex,
          round: slot.round,
          pick: slot.pick,
          queueLen: playerQueue.getEntry(slot.teamIndex).fantraxIds.length,
        });
        return null;
      }

      try {
        const result = this.submitPick({
          discordUserId: drafterId,
          fantraxId,
          round: slot.round,
          pick: slot.pick,
          source: 'autodraft',
        });
        audit('autodraft.ok', {
          teamIndex: slot.teamIndex,
          round: slot.round,
          pick: slot.pick,
          fantraxId,
          teamName: slot.teamName || slot.displayName,
        });
        return result;
      } catch (err) {
        console.warn(
          `Autodraft skipped ${fantraxId} for ${slot.round}.${slot.pick}: ${err.message}`,
        );
        audit('autodraft.fail', {
          teamIndex: slot.teamIndex,
          round: slot.round,
          pick: slot.pick,
          fantraxId,
          error: err.message,
        });
        // Avoid infinite retry on a stuck id (e.g. race); drop and try next.
        try {
          playerQueue.removePlayer(slot.teamIndex, fantraxId, {
            reason: 'autodraft_fail',
          });
        } catch {
          return null;
        }
      }
    }
  }

  async announceAutodraft(result) {
    const channel = await this.getDraftChannel();
    if (!channel) return;
    const team =
      result.pickRecord.teamName || result.pickRecord.displayName || 'team';
    await channel.send(
      `Autodrafted **${result.line}** for **${team}** (${mentionOwners(result.pickRecord)}) _(queue)_`,
    );
  }

  async skipForRepeatInactivity(state, slot, openSkips) {
    this.pushSkipRecord(state, slot);
    state.currentIndex += 1;
    this.persist(state);
    audit('skip', {
      reason: 'repeat_skips',
      openSkips,
      round: slot.round,
      pick: slot.pick,
      teamIndex: slot.teamIndex,
      teamName: slot.teamName || slot.displayName,
      discordUserId: slot.discordUserId,
    });
    const channel = await this.getDraftChannel();
    if (channel) {
      const team = slot.teamName || slot.displayName;
      await channel.send(
        `**${team}** (${mentionOwners(slot)}) already has **${openSkips}** open skips — ` +
          `**${slot.round}.${slot.pick}** marked **skipped**. Catch-up still allowed.`,
      );
    }
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
      await this.proceedToNextPick();
      return;
    }

    this.pushSkipRecord(state, slot);

    const channel = await this.getDraftChannel();
    if (channel) {
      await channel.send(
        `Time expired — **${slot.round}.${slot.pick}** for **${slot.teamName || slot.displayName}** (${mentionOwners(slot)}) marked **skipped**. They can still claim it later.`,
      );
    }

    state.currentIndex += 1;
    this.persist(state);
    audit('skip', {
      reason: 'timeout',
      round: slot.round,
      pick: slot.pick,
      teamIndex: slot.teamIndex,
      teamName: slot.teamName || slot.displayName,
      discordUserId: slot.discordUserId,
    });
    await this.proceedToNextPick();
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

  /**
   * Rebuild the live pick queue from current config (start_round / total_rounds)
   * without wiping recorded picks. Used when /draft-setup changes mid-draft.
   */
  syncQueueToConfig() {
    const state = this.getState();
    if (state.status !== 'running' && state.status !== 'paused') {
      return { changed: false, reason: 'inactive' };
    }

    const config = this.getConfig();
    const order = this.getOrder();
    const err = validateOrder(order, {
      allowDuplicateOwners: order.allowDuplicateOwners || config.allowDuplicateOwners,
    });
    if (err) throw new Error(err);

    const prev = this.currentSlot(state);
    const newQueue = buildQueue({
      teams: order.teams,
      snake: config.snake ?? order.snake,
      startRound: config.startRound,
      totalRounds: config.totalRounds,
    });

    const keySet = new Set(newQueue.map((s) => `${s.round}.${s.pick}`));
    state.skipped = (state.skipped || []).filter((s) => keySet.has(`${s.round}.${s.pick}`));

    let newIndex = 0;
    if (prev) {
      const idx = newQueue.findIndex(
        (s) => s.round === prev.round && s.pick === prev.pick,
      );
      if (idx >= 0) newIndex = idx;
      else {
        // Current slot fell outside the new window — land on first open slot
        newIndex = 0;
      }
    }

    state.queue = newQueue;
    state.currentIndex = newIndex;
    this.advanceToNextOpen(state);
    this.persist(state);

    const endRound = newQueue.length ? newQueue[newQueue.length - 1].round : null;
    return {
      changed: true,
      startRound: config.startRound,
      totalRounds: config.totalRounds,
      endRound,
      queueLen: newQueue.length,
      currentIndex: state.currentIndex,
    };
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
    audit('draft.start', {
      startRound: config.startRound,
      totalRounds: config.totalRounds,
      queueLen: state.queue.length,
    });

    if (announce) {
      return this.proceedToNextPick().then(() => this.getState());
    }
    this.startClock(state);
    return state;
  }

  pause() {
    const state = this.getState();
    if (state.status !== 'running') throw new Error('Draft is not running.');
    state.status = 'paused';
    state.pausedAt = new Date().toISOString();
    this.timer.clear();
    this.persist(state);
    audit('draft.pause', {});
    return state;
  }

  resume() {
    const state = this.getState();
    if (state.status !== 'paused') throw new Error('Draft is not paused.');
    state.status = 'running';
    state.pausedAt = null;
    this.persist(state);
    audit('draft.resume', {});
    return this.proceedToNextPick();
  }

  end() {
    const state = this.getState();
    state.status = 'ended';
    state.clockEndsAt = null;
    this.timer.clear();
    this.persist(state);
    pool.saveToFile();
    audit('draft.end', {});
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

    this.pushSkipRecord(state, slot);
    state.currentIndex += 1;
    this.persist(state);
    audit('skip', {
      reason: 'admin',
      round: slot.round,
      pick: slot.pick,
      teamIndex: slot.teamIndex,
      teamName: slot.teamName || slot.displayName,
      discordUserId: slot.discordUserId,
    });
    // Caller must await proceedToNextPick() after posting the skip notice
    return { state: this.getState(), slot };
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
      // No explicit slot: oldest open skip, else on-clock if owned
      const target = this.oldestOpenSlotForUser(state, discordUserId);
      if (target) {
        const skip = this.findSkip(state, target.round, target.pick);
        targetSlot = state.queue.find((q) => q.round === target.round && q.pick === target.pick);
        isCatchUp = Boolean(skip);
      } else if (!adminOverride) {
        throw new Error("It is not your team's turn and you have no open skipped picks.");
      } else {
        throw new Error('No target slot.');
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
    playerQueue.removeFantraxIdFromAllQueues(player.fantraxId);

    const wasCurrent =
      current &&
      current.round === pickRecord.round &&
      current.pick === pickRecord.pick;

    if (wasCurrent) {
      state.currentIndex += 1;
      state.clockEndsAt = null;
      this.timer.clear();
      this.persist(state);
      // Do not startClock/autodraft here — callers post the pick first, then
      // await proceedToNextPick() so announcements stay in order.
    } else {
      this.persist(state);
    }

    audit('pick', {
      source,
      round: pickRecord.round,
      pick: pickRecord.pick,
      fantraxId: pickRecord.fantraxId,
      teamIndex: targetSlot.teamIndex,
      teamName: pickRecord.teamName,
      discordUserId: pickRecord.discordUserId,
      catchUp: isCatchUp,
      wasCurrent,
    });

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
    const config = this.getConfig();
    if (!config.allowEditPicks) {
      throw new Error(
        'Pick editing is disabled. An admin can enable it with `/draft-setup allow_edit_picks:True`.',
      );
    }

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
    playerQueue.removeFantraxIdFromAllQueues(newPlayer.fantraxId);

    existing.fantraxId = newPlayer.fantraxId;
    existing.playerName = newPlayer.name;
    existing.position = newPlayer.position;
    existing.team = newPlayer.team;
    existing.at = new Date().toISOString();
    existing.source = 'edit';
    existing.editedBy = String(discordUserId);
    existing.replacedFantraxId = previous.fantraxId;

    this.persist(state);

    audit('pick.edit', {
      round: existing.round,
      pick: existing.pick,
      fromFantraxId: previous.fantraxId,
      toFantraxId: newPlayer.fantraxId,
      teamName: existing.teamName || existing.displayName,
      by: String(discordUserId),
    });

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
    audit('pick.undo', {
      round: last.round,
      pick: last.pick,
      fantraxId: last.fantraxId,
      teamName: last.teamName || last.displayName,
      source: last.source,
    });
    return last;
  }

  statusSummary() {
    const state = this.getState();
    this.syncTeamsFromOrder(state);
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

    return this.proceedToNextPick({ remainingMs: rem });
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
      const config = this.getConfig();
      this.timer.start(
        remaining,
        async () => {
          await this.handleTimeout();
        },
        {
          warningsSec: config.pickWarningsSec || [],
          onWarning: async (secondsLeft) => {
            await this.announceWarning(secondsLeft);
          },
        },
      );
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
