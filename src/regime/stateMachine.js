/**
 * My Next Prediction v3.0 — Regime State Machine
 * ----------------------------------------------
 * Wraps the raw classifier output with:
 *   - Hysteresis: a transition only happens after `confirmBars` of consistent
 *     signal — prevents single-bar flips whipsawing downstream consumers.
 *   - History: keeps the last N transitions with their timestamp + bar index.
 *   - Dwell time: reports how long the current state has persisted.
 *
 * Intended usage:
 *   const fsm = new RegimeFSM({ confirmBars: 3 });
 *   for each bar: fsm.observe(classifyRegime(ta, { i }))
 *   → fsm.current gives stable state
 *   → fsm.history is an append-only array of transitions
 */

const STATE_KEY = (r) => `${r.trend}|${r.strength}|${r.volatility}`;

export class RegimeFSM {
  /**
   * @param {object} [opts]
   * @param {number} [opts.confirmBars=3]  min consecutive bars of a new regime
   *                                       before the FSM switches
   * @param {number} [opts.maxHistory=200] cap history length
   */
  constructor(opts = {}) {
    this.confirmBars = Math.max(1, opts.confirmBars ?? 3);
    this.maxHistory = opts.maxHistory ?? 200;
    /** @type {object|null} current committed regime */
    this.current = null;
    /** @type {object|null} candidate regime under observation */
    this._pending = null;
    /** @type {number} consecutive bars supporting _pending */
    this._pendingCount = 0;
    /** @type {number} bar index when current was committed */
    this._enteredAt = 0;
    /** @type {Array<{from:object|null,to:object,i:number,t:number|null}>} */
    this.history = [];
  }

  /**
   * Feed one bar's classification. Returns the *committed* state
   * (which only changes when hysteresis is satisfied).
   *
   * @param {object} regime   output of classifyRegime()
   * @param {object} [meta]
   * @param {number} [meta.i] bar index
   * @param {number} [meta.t] bar timestamp (ms)
   */
  observe(regime, meta = {}) {
    if (!regime) return this.current;
    const i = Number.isInteger(meta.i) ? meta.i : (this.current ? this._enteredAt + (this.dwellBars ?? 0) + 1 : 0);
    const t = Number.isFinite(meta.t) ? meta.t : null;

    if (!this.current) {
      // Cold start — first observation becomes the state immediately.
      this.current = regime;
      this._enteredAt = i;
      this._recordTransition(null, regime, i, t);
      this._pending = null;
      this._pendingCount = 0;
      return this.current;
    }

    const sameAsCurrent = STATE_KEY(regime) === STATE_KEY(this.current);
    if (sameAsCurrent) {
      // Reinforce current; clear any pending change.
      this._pending = null;
      this._pendingCount = 0;
      return this.current;
    }

    // Different from current → start/continue pending.
    if (!this._pending || STATE_KEY(this._pending) !== STATE_KEY(regime)) {
      this._pending = regime;
      this._pendingCount = 1;
    } else {
      this._pendingCount++;
    }

    if (this._pendingCount >= this.confirmBars) {
      const prev = this.current;
      this.current = this._pending;
      this._recordTransition(prev, this.current, i, t);
      this._enteredAt = i;
      this._pending = null;
      this._pendingCount = 0;
    }
    return this.current;
  }

  /** Bars spent in the current committed state (0 if just entered). */
  dwellBars(currentBarIndex) {
    if (!this.current) return 0;
    return Math.max(0, (currentBarIndex ?? 0) - this._enteredAt);
  }

  _recordTransition(from, to, i, t) {
    this.history.push({ from, to, i, t });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /**
   * Run the FSM over an entire series of classifications.
   * @param {Array<object>} series  output of classifySeries()
   * @param {number[]} [timestamps]
   * @returns {{ committed: object[], transitions: Array }}
   */
  static runSeries(series, timestamps = []) {
    const fsm = new RegimeFSM();
    const committed = new Array(series.length);
    for (let i = 0; i < series.length; i++) {
      committed[i] = fsm.observe(series[i], { i, t: timestamps[i] ?? null });
    }
    return { committed, transitions: fsm.history };
  }

  snapshot() {
    return {
      current: this.current,
      pending: this._pending,
      pendingCount: this._pendingCount,
      enteredAt: this._enteredAt,
      transitionsCount: this.history.length,
      lastTransitions: this.history.slice(-5),
    };
  }
}
