// backend/src/api/analysisLimiter.js

const { config } = require("../core/config");
const { AppError, serviceUnavailable } = require("../core/errors");

// Nobody receives this response, since the client has gone, but the request
// log records its status. 499 is nginx's code for a request the client closed.
function clientGone() {
  return new AppError({
    code: "ANALYZE_CLIENT_GONE",
    message: "Client closed the request",
    statusCode: 499,
    expose: true,
  });
}

/**
 * Simple in-memory concurrency limiter for /analyze.
 *
 * Why:
 * - Analysis involves network fetch + regex matching.
 * - Unbounded concurrency can exhaust sockets/CPU and make the service unstable.
 *
 * Design:
 * - Limit concurrent executions
 * - Optional bounded queue to smooth small bursts
 * - A queued request leaves the queue after queueTimeoutMs, or when its client goes away
 *
 * @param {{maxConcurrent: number, maxQueued: number, queueTimeoutMs: number}} param0 - Concurrency and queue caps
 * @returns {{acquire: (signal?: AbortSignal) => Promise<Function>, stats: () => {inFlight: number, queued: number}}} Limiter instance
 */

function createLimiter({ maxConcurrent, maxQueued, queueTimeoutMs }) {
  let inFlight = 0;
  const queue = [];

  /**
   * Waits for a free slot and returns the function that releases it.
   *
   * @param {AbortSignal} [signal] - Aborted when the client goes away, which takes a queued request out of the queue
   * @returns {Promise<Function>} `release`, to call once the analysis is done
   * @throws {AppError} 503 when the queue is full or the wait runs past `queueTimeoutMs`, 499 when `signal` aborts
   */
  async function acquire(signal) {
    if (inFlight < maxConcurrent) {
      inFlight++;
      return release;
    }

    // Reject immediately once queue is full so requests fail fast instead of
    // accumulating unbounded memory and latency under sustained load.
    if (queue.length >= maxQueued) {
      throw serviceUnavailable(
        "ANALYZE_OVERLOADED",
        "Service is busy. Please retry in a moment.",
      );
    }

    return new Promise((resolve, reject) => {
      // A waiter leaves the queue one of three ways: release() hands it a
      // slot, it waits too long, or its client goes away. Whichever comes
      // first cancels the other two.
      const waiter = {
        resolve(releaseFn) {
          stop();
          resolve(releaseFn);
        },
      };
      const leave = (err) => {
        const i = queue.indexOf(waiter);
        if (i !== -1) queue.splice(i, 1);
        stop();
        reject(err);
      };
      const onAbort = () => leave(clientGone());
      const timer = setTimeout(
        () =>
          leave(
            serviceUnavailable(
              "ANALYZE_QUEUE_TIMEOUT",
              "Service is busy. Please retry in a moment.",
            ),
          ),
        queueTimeoutMs,
      );
      function stop() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }

  function release() {
    // Hand the slot to a queued waiter if available.
    const next = queue.shift();
    if (next) {
      // Keep inFlight the same: slot transfers to next.
      next.resolve(release);
      return;
    }
    inFlight = Math.max(0, inFlight - 1);
  }

  return { acquire, stats: () => ({ inFlight, queued: queue.length }) };
}

const limiter = createLimiter({
  maxConcurrent: config.api.maxConcurrentAnalyses,
  maxQueued: config.api.maxQueuedAnalyses,
  queueTimeoutMs: config.api.queueTimeoutMs,
});

module.exports = { analysisLimiter: limiter };
