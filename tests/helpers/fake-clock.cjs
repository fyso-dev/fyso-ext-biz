'use strict';
// A controllable clock for the `now` seam every production module takes (`now: clock.now`), plus a
// switch that makes `AbortSignal.timeout(ms)` follow the same clock, so a 15 s Biz timeout is
// tested by `clock.advance(15_000)` instead of waiting.

/**
 * The windows the production code uses. They are private constants there (nothing exports them), so
 * tests/helpers.test.cjs pins each one to the behaviour of the real module: if production changes
 * a window, that self-test fails and this table is the single place to update.
 */
const WINDOWS = Object.freeze({
  REPORT_FRESH_MS: 30_000,            // project-access: a cached access report answers without calling Biz
  REPORT_STALE_MS: 300_000,           // project-access: a cached report still covers transient Biz failures
  REPORT_CACHE_MAX: 100,              // project-access: tokens kept in the report cache
  ACCESS_TIMEOUT_MS: 15_000,          // project-access: report and decision calls (slow server-side)
  SHORT_TIMEOUT_MS: 5_000,            // project-access: every other Biz call
  CREDENTIAL_EXPIRY_MS: 8 * 3_600_000, // Biz: lifetime of a profile credential (the default `expires_in` of fake-biz)
  LOGIN_TTL_MS: 600_000,              // profile-session: a login started and not finished
  SESSION_TTL_MS: 3_600_000,          // profile-session: a signed-in session (capped by the credential's own expiry)
  REFRESH_MARGIN_MS: 60_000,          // auth: a token expiring within this is renewed
  SETUP_LOCK_STALE_MS: 30 * 60_000,   // managed-setup: a setup.lock older than this is taken over
  KEY_RETRY_MS: 1_500,                // managed-setup: pause before the second `dist:key` attempt
});

const START = Date.UTC(2026, 0, 1);

/**
 * @param {{start?: number}} [options] initial epoch milliseconds (default 2026-01-01T00:00:00Z)
 * @returns {{now: () => number, advance: (ms: number) => number, set: (ms: number) => number,
 *   iso: () => string, timer: (ms: number, fn: () => void) => () => void,
 *   installAbortTimeout: (t: {after: Function}) => void, timeouts: number[], WINDOWS: typeof WINDOWS}}
 */
function fakeClock({start = START} = {}) {
  let current = start;
  const timers = [];   // {at, fn}
  const timeouts = []; // every ms value passed to the patched AbortSignal.timeout

  const run = target => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > target) break;
      const next = timers.shift();
      current = Math.max(current, next.at);
      next.fn();
    }
    current = target;
    return current;
  };

  const clock = {
    /** Pass as `now`: `projectAccess({now: clock.now})`. A bound arrow, safe to detach. */
    now: () => current,
    /** Move forward `ms`, firing the timers (and patched abort timeouts) that fall due, in order. */
    advance: ms => run(current + ms),
    /** Jump to an absolute epoch ms (forward fires timers; backward just sets it). */
    set: ms => (ms >= current ? run(ms) : (current = ms)),
    /** The current time as the ISO string production writes into notices and state. */
    iso: () => new Date(current).toISOString(),
    /** Run `fn` when the clock reaches now+ms. Returns a cancel function. */
    timer(ms, fn) {
      const entry = {at: current + ms, fn};
      timers.push(entry);
      return () => { const i = timers.indexOf(entry); if (i >= 0) timers.splice(i, 1); };
    },
    /**
     * Make `AbortSignal.timeout(ms)` fire when this clock advances `ms` (rejecting with the same
     * TimeoutError DOMException the real one gives), and record each `ms` in `clock.timeouts` so a
     * test can assert "report calls get 15 s". Restored automatically after the test `t`.
     */
    installAbortTimeout(t) {
      const original = AbortSignal.timeout;
      AbortSignal.timeout = ms => {
        const controller = new AbortController();
        timeouts.push(ms);
        clock.timer(ms, () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
        return controller.signal;
      };
      t.after(() => { AbortSignal.timeout = original; });
    },
    timeouts,
    WINDOWS,
  };
  return clock;
}

module.exports = {fakeClock, WINDOWS, START};
