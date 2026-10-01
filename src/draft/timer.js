/**
 * Pick clock with optional mid-pick warning callbacks.
 * Warnings fire when a given number of seconds remain on the clock.
 */
class DraftTimer {
  constructor() {
    this._timeout = null;
    this._warningTimeouts = [];
    this._onExpire = null;
  }

  clear() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
    for (const t of this._warningTimeouts) clearTimeout(t);
    this._warningTimeouts = [];
    this._onExpire = null;
  }

  /**
   * @param {number} ms — total remaining clock time
   * @param {() => void | Promise<void>} onExpire
   * @param {{ warningsSec?: number[], onWarning?: (secondsLeft: number) => void | Promise<void> }} [opts]
   *   warningsSec = seconds remaining when each warning should fire (must be < total ms)
   */
  start(ms, onExpire, opts = {}) {
    this.clear();
    this._onExpire = onExpire;

    const warningsSec = Array.isArray(opts.warningsSec) ? opts.warningsSec : [];
    const onWarning = opts.onWarning;
    const remainingSec = ms / 1000;

    if (onWarning) {
      for (const at of warningsSec) {
        const n = Number(at);
        if (!Number.isFinite(n) || n <= 0 || n >= remainingSec) continue;
        const delayMs = Math.max(0, ms - n * 1000);
        const handle = setTimeout(() => {
          Promise.resolve(onWarning(n)).catch(() => {});
        }, delayMs);
        if (typeof handle.unref === 'function') handle.unref();
        this._warningTimeouts.push(handle);
      }
    }

    if (ms <= 0) {
      Promise.resolve().then(() => this._fire());
      return;
    }
    this._timeout = setTimeout(() => this._fire(), ms);
    if (typeof this._timeout.unref === 'function') this._timeout.unref();
  }

  async _fire() {
    this._timeout = null;
    for (const t of this._warningTimeouts) clearTimeout(t);
    this._warningTimeouts = [];
    const cb = this._onExpire;
    this._onExpire = null;
    if (cb) await cb();
  }
}

module.exports = { DraftTimer };
