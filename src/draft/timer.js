/**
 * Pick clock with optional mid-pick warning callbacks.
 * Warnings fire when a given number of seconds remain on the clock.
 * The expire deadline and warning timers are independent — refreshing
 * warnings never resets the pick timeout.
 */
class DraftTimer {
  constructor() {
    this._timeout = null;
    this._warningTimeouts = [];
    this._onExpire = null;
    this._onWarning = null;
    this._endsAt = null;
  }

  clear() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
    this.clearWarnings();
    this._onExpire = null;
    this._onWarning = null;
    this._endsAt = null;
  }

  clearWarnings() {
    for (const t of this._warningTimeouts) clearTimeout(t);
    this._warningTimeouts = [];
  }

  /**
   * @param {number} ms — total remaining clock time
   * @param {() => void | Promise<void>} onExpire
   * @param {{ warningsSec?: number[], onWarning?: (secondsLeft: number) => void | Promise<void> }} [opts]
   */
  start(ms, onExpire, opts = {}) {
    this.clear();
    this._onExpire = onExpire;
    this._onWarning = opts.onWarning || null;
    this._endsAt = Date.now() + Math.max(0, ms);

    this.armWarnings(opts.warningsSec || []);

    if (ms <= 0) {
      Promise.resolve().then(() => this._fire());
      return;
    }
    this._timeout = setTimeout(() => this._fire(), ms);
    if (typeof this._timeout.unref === 'function') this._timeout.unref();
  }

  /**
   * Re-arm warning timers from the current expire deadline without touching it.
   * @param {number[]} warningsSec
   * @param {(secondsLeft: number) => void | Promise<void>} [onWarning]
   */
  refreshWarnings(warningsSec, onWarning) {
    if (onWarning) this._onWarning = onWarning;
    if (this._endsAt == null || !this._onExpire) {
      this.clearWarnings();
      return false;
    }
    this.armWarnings(warningsSec || []);
    return true;
  }

  armWarnings(warningsSec) {
    this.clearWarnings();
    const onWarning = this._onWarning;
    if (!onWarning || this._endsAt == null) return;

    const remainingMs = this._endsAt - Date.now();
    if (remainingMs <= 0) return;
    const remainingSec = remainingMs / 1000;

    for (const at of warningsSec || []) {
      const n = Number(at);
      if (!Number.isFinite(n) || n <= 0 || n >= remainingSec) continue;
      const delayMs = Math.max(0, remainingMs - n * 1000);
      const handle = setTimeout(() => {
        Promise.resolve(onWarning(n)).catch(() => {});
      }, delayMs);
      if (typeof handle.unref === 'function') handle.unref();
      this._warningTimeouts.push(handle);
    }
  }

  async _fire() {
    this._timeout = null;
    this.clearWarnings();
    this._endsAt = null;
    const cb = this._onExpire;
    this._onExpire = null;
    this._onWarning = null;
    if (cb) await cb();
  }
}

module.exports = { DraftTimer };
