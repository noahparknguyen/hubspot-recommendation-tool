/**
 * Unit tests for the /analyze concurrency limiter.
 *
 * Validates:
 * - immediate acquisition up to maxConcurrent
 * - queued acquisitions resolve when releases happen
 * - queue overflow produces 503 AppError (serviceUnavailable)
 * - a queued request that waits past ANALYSIS_QUEUE_TIMEOUT_MS gets a 503 and frees its place
 * - a queued request whose client leaves is dropped, and the slot goes to the next one
 * - a request that has been given a slot is unaffected by its timer or a later abort
 */
describe("api/analysisLimiter", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("allows up to MAX_CONCURRENT_ANALYSES and queues up to MAX_QUEUED_ANALYSES", async () => {
    process.env.MAX_CONCURRENT_ANALYSES = "2";
    process.env.MAX_QUEUED_ANALYSES = "1";

    const { analysisLimiter } = require("../src/api/analysisLimiter");

    const r1 = await analysisLimiter.acquire();
    const r2 = await analysisLimiter.acquire();

    // Third should be queued (not rejected)
    const p3 = analysisLimiter.acquire();
    expect(analysisLimiter.stats()).toEqual({ inFlight: 2, queued: 1 });

    // Release one slot -> queued one resolves
    r1();
    const r3 = await p3;
    expect(typeof r3).toBe("function");
    expect(analysisLimiter.stats()).toEqual({ inFlight: 2, queued: 0 });

    // cleanup
    r2();
    r3();
    expect(analysisLimiter.stats().inFlight).toBe(0);
  });

  test("rejects when queue is full", async () => {
    process.env.MAX_CONCURRENT_ANALYSES = "1";
    process.env.MAX_QUEUED_ANALYSES = "0";

    const { analysisLimiter } = require("../src/api/analysisLimiter");
    const r1 = await analysisLimiter.acquire();

    await expect(analysisLimiter.acquire()).rejects.toMatchObject({
      name: "AppError",
      statusCode: 503,
      code: "ANALYZE_OVERLOADED",
    });

    r1();
  });

  test("rejects a queued request that waits too long, and frees its place", async () => {
    process.env.MAX_CONCURRENT_ANALYSES = "1";
    process.env.MAX_QUEUED_ANALYSES = "1";
    process.env.ANALYSIS_QUEUE_TIMEOUT_MS = "50";

    const { analysisLimiter } = require("../src/api/analysisLimiter");
    const r1 = await analysisLimiter.acquire();

    await expect(analysisLimiter.acquire()).rejects.toMatchObject({
      statusCode: 503,
      code: "ANALYZE_QUEUE_TIMEOUT",
    });
    expect(analysisLimiter.stats()).toEqual({ inFlight: 1, queued: 0 });

    // The freed place can be taken again.
    const p3 = analysisLimiter.acquire();
    expect(analysisLimiter.stats().queued).toBe(1);
    r1();
    const r3 = await p3;
    r3();
    expect(analysisLimiter.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  test("drops a queued request whose client leaves, and passes the slot on", async () => {
    process.env.MAX_CONCURRENT_ANALYSES = "1";
    process.env.MAX_QUEUED_ANALYSES = "2";
    process.env.ANALYSIS_QUEUE_TIMEOUT_MS = "60000";

    const { analysisLimiter } = require("../src/api/analysisLimiter");
    const r1 = await analysisLimiter.acquire();

    const left = new AbortController();
    const p2 = analysisLimiter.acquire(left.signal);
    const p3 = analysisLimiter.acquire();
    left.abort();

    await expect(p2).rejects.toMatchObject({
      statusCode: 499,
      code: "ANALYZE_CLIENT_GONE",
    });
    expect(analysisLimiter.stats()).toEqual({ inFlight: 1, queued: 1 });

    r1();
    const r3 = await p3;
    r3();
    expect(analysisLimiter.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  test("leaves a request alone once it has a slot", async () => {
    process.env.MAX_CONCURRENT_ANALYSES = "1";
    process.env.MAX_QUEUED_ANALYSES = "1";
    process.env.ANALYSIS_QUEUE_TIMEOUT_MS = "50";

    const { analysisLimiter } = require("../src/api/analysisLimiter");
    const r1 = await analysisLimiter.acquire();

    const left = new AbortController();
    const p2 = analysisLimiter.acquire(left.signal);
    r1();
    const r2 = await p2;

    // Past its queue deadline, and then its client leaves: neither touches
    // the slot it already holds.
    await new Promise((r) => setTimeout(r, 100));
    left.abort();
    expect(analysisLimiter.stats()).toEqual({ inFlight: 1, queued: 0 });

    r2();
    expect(analysisLimiter.stats()).toEqual({ inFlight: 0, queued: 0 });
  });
});
