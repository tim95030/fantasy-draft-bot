/**
 * Pick clock. Calls onExpire when the current slot times out.
 */
class DraftTimer {
  constructor() {
    this._timeout = null;
    this._onExpire = null;
  }

  clear() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  /**
   * @param {number} ms
   * @param {() => void | Promise<void>} onExpire
   */
  start(ms, onExpire) {
    this.clear();
    this._onExpire = onExpire;
    if (ms <= 0) {
      Promise.resolve().then(() => this._fire());
      return;
    }
    this._timeout = setTimeout(() => this._fire(), ms);
    // Don't keep the Node process alive solely for the pick clock
    if (typeof this._timeout.unref === 'function') this._timeout.unref();
  }

  async _fire() {
    this._timeout = null;
    const cb = this._onExpire;
    this._onExpire = null;
    if (cb) await cb();
  }
}

module.exports = { DraftTimer };
