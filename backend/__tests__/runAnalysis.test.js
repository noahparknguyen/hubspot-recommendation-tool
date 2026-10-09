/**
 * Tests for the analysis worker thread, run for real: a real thread, with the
 * real dataset.
 *
 * Covers:
 * - The thread returns the same result as analyzing on the calling thread
 * - A page that backtracks past the time limit is stopped with a 504, while
 *   the calling thread stays free, and the stopped thread stops using CPU
 * - The next job after a timeout runs on a fresh thread
 *
 * The tests share one module instance and run in order: the last one needs
 * the timeout before it.
 */
const normalPage = {
  finalUrl: "https://example.com/",
  status: 200,
  headers: { server: "nginx", "x-powered-by": "Express" },
  html: `<html><head>
    <meta name="generator" content="WordPress 6.5.2">
    <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
  </head><body><p>Hello</p></body></html>`,
  external: { scripts: [], stylesheets: [] },
};

// A script src of "1.1.1.…" makes dozens of the dataset's version patterns
// backtrack quadratically. At 200 KB it runs for many minutes.
const craftedPage = {
  ...normalPage,
  headers: {},
  html: `<script src="${"1.".repeat(100_000)}"></script>`,
};

describe("core/worker/runAnalysis", () => {
  let runAnalysis;
  let config;

  beforeAll(() => {
    jest.resetModules();
    ({ runAnalysis } = require("../src/core/worker/runAnalysis"));
    ({ config } = require("../src/core/config"));
  });

  test("returns the same result as analyzing on this thread", async () => {
    const {
      analyzeFetched,
      initTechDb,
    } = require("../src/core/analyzeFetched");
    const expected = analyzeFetched(await initTechDb(), normalPage);

    const result = await runAnalysis(normalPage);

    expect(expected.detections.length).toBeGreaterThanOrEqual(3);
    expect(result).toEqual(expected);
  }, 20_000);

  test("stops a page that runs past the limit, and keeps this thread free", async () => {
    config.analysis.timeoutMs = 1_000;
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 50);
    const start = Date.now();

    try {
      await expect(runAnalysis(craftedPage)).rejects.toMatchObject({
        code: "ANALYSIS_TIMEOUT",
        statusCode: 504,
      });
    } finally {
      clearInterval(ticker);
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(5_000);
    // About 20 if this thread was free the whole time, and 0 or 1 if the
    // analysis had blocked it.
    expect(ticks).toBeGreaterThanOrEqual(5);

    // The stopped thread must really stop. process.cpuUsage() counts every
    // thread, so one still backtracking would use about 500 ms of CPU here.
    await new Promise((r) => setTimeout(r, 200));
    const before = process.cpuUsage();
    await new Promise((r) => setTimeout(r, 500));
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(250);
  }, 20_000);

  test("runs the next job on a fresh thread after a timeout", async () => {
    config.analysis.timeoutMs = 60_000;

    const result = await runAnalysis(normalPage);

    expect(result.detections.length).toBeGreaterThanOrEqual(3);
  }, 20_000);
});
