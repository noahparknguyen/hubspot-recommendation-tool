// backend/src/api/rateLimit.js
// Simple in-memory rate limiter, for failed auth attempts and for the optional
// per-client analysis limit. Not intended as a distributed limiter.
// Best-effort protection against brute-force noise.
//
// Strategy:
// - Track failed attempts per IP in a sliding window.
// - When max failures is exceeded, block for blockMs.
// - Successful auth clears failures for that IP.
//
// Callers key it with getClientIp (clientIp.js).

function nowMs() {
  return Date.now();
}

/**
 * Creates an in-memory limiter keyed by client IP.
 * State is process-local and resets on restart, so treat it as best-effort protection.
 *
 * @param {{windowMs?: number, maxFailures?: number, blockMs?: number}} [opts] - Limiter thresholds
 * @returns {{isBlocked: Function, recordFailure: Function, recordSuccess: Function, _state: Map<any, any>, _opts: object}} Limiter API and debug state
 */
function createRateLimiter(opts) {
  const windowMs = Number(opts && opts.windowMs) || 60_000;
  const maxFailures = Number(opts && opts.maxFailures) || 12;
  const blockMs = Number(opts && opts.blockMs) || 300_000;

  // ip -> { firstAt, count, blockedUntil, lastSeen }
  const state = new Map();

  function cleanup() {
    // Keep memory bounded: remove entries that haven't been seen in ~2 windows
    const cutoff = nowMs() - Math.max(windowMs * 2, 5 * 60_000);
    for (const [ip, s] of state.entries()) {
      if ((s.lastSeen || 0) < cutoff && (s.blockedUntil || 0) < cutoff) {
        state.delete(ip);
      }
    }
  }

  function isBlocked(ip) {
    const s = state.get(ip);
    if (!s) return { blocked: false, retryAfterSeconds: 0 };
    const n = nowMs();
    if (s.blockedUntil && s.blockedUntil > n) {
      const retry = Math.ceil((s.blockedUntil - n) / 1000);
      return { blocked: true, retryAfterSeconds: retry };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  function recordFailure(ip) {
    const n = nowMs();
    const s = state.get(ip);

    if (!s) {
      state.set(ip, { firstAt: n, count: 1, blockedUntil: 0, lastSeen: n });
      cleanup();
      return isBlocked(ip);
    }

    s.lastSeen = n;

    // Failure window elapsed; start a new one
    if (!s.firstAt || n - s.firstAt > windowMs) {
      s.firstAt = n;
      s.count = 1;
      s.blockedUntil = 0;
      cleanup();
      return isBlocked(ip);
    }

    s.count += 1;

    if (s.count > maxFailures) {
      s.blockedUntil = n + blockMs;
    }

    cleanup();
    return isBlocked(ip);
  }

  function recordSuccess(ip) {
    if (!ip) return;
    state.delete(ip);
  }

  return {
    isBlocked,
    recordFailure,
    recordSuccess,
    // for debugging/tests
    _state: state,
    _opts: { windowMs, maxFailures, blockMs },
  };
}

module.exports = { createRateLimiter };
