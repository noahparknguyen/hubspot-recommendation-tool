/**
 * Unit tests for the Phase 1..5 orchestrator (analyzeUrl + initTechDb).
 *
 * We mock each phase boundary to ensure:
 * - initTechDb caches the loaded DB and de-dupes concurrent initialization
 * - analyzeUrl wires together fetchPage -> buildSignals -> detectTechnologies -> enrich -> summarize -> group -> recommendations
 * - outputs are stably sorted (confidence desc then name asc)
 * - htmlTruncated from fetchPage is propagated to the returned report object
 * - debugSignals are included only when config.debugSignals is enabled
 *
 * The analysis thread itself is covered by runAnalysis.test.js.
 */
describe("core/analyzer - initTechDb / analyzeUrl", () => {
  beforeEach(() => {
    jest.resetModules();
    // The real runAnalysis hands the page to a worker thread, which these
    // mocks can't reach. This stand-in runs the same code on this thread.
    jest.doMock("../src/core/worker/runAnalysis", () => {
      const {
        analyzeFetched,
        initTechDb,
      } = require("../src/core/analyzeFetched");
      return {
        runAnalysis: async (fetched) =>
          analyzeFetched(await initTechDb(), fetched),
      };
    });
  });

  test("initTechDb loads DB only once (even with concurrent calls)", async () => {
    const db = { technologies: { React: { name: "React" } } };
    const loadTechDb = jest.fn(async () => {
      // simulate some latency
      await new Promise((r) => setTimeout(r, 10));
      return db;
    });

    jest.doMock("../src/core/techdb/loadTechDb", () => ({ loadTechDb }));

    // Minimal mocks to satisfy require graph
    jest.doMock("../src/core/fetch/fetchPage", () => ({
      fetchPage: jest.fn(),
    }));
    jest.doMock("../src/core/normalize/signals", () => ({
      buildSignals: jest.fn(),
    }));
    jest.doMock("../src/core/detect/detectTechnologies", () => ({
      detectTechnologies: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/enrichDetections", () => ({
      enrichDetections: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/recommendations", () => ({
      buildRecommendations: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/summarize", () => ({
      buildSummary: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/groupDetections", () => ({
      groupDetections: jest.fn(() => ({})),
    }));

    const { initTechDb } = require("../src/core/analyzeFetched");

    const [a, b, c] = await Promise.all([
      initTechDb(),
      initTechDb(),
      initTechDb(),
    ]);
    expect(a).toBe(db);
    expect(b).toBe(db);
    expect(c).toBe(db);
    expect(loadTechDb).toHaveBeenCalledTimes(1);
  });

  test("analyzeUrl produces a stable report and sorted detections", async () => {
    const db = {
      technologies: { React: { name: "React" }, Vue: { name: "Vue" } },
    };

    jest.doMock("../src/core/techdb/loadTechDb", () => ({
      loadTechDb: jest.fn(async () => db),
    }));

    jest.doMock("../src/core/fetch/fetchPage", () => ({
      fetchPage: jest.fn(async () => ({
        timingMs: 5,
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/html",
        bytes: 123,
        headers: { server: "x" },
        html: "<html></html>",
        external: { scripts: [], stylesheets: [] },
      })),
    }));

    jest.doMock("../src/core/normalize/signals", () => ({
      buildSignals: jest.fn(() => ({ url: "https://example.com/" })),
    }));

    // Return unsorted detections, analyzer should enrich then sort by confidence desc then name asc
    jest.doMock("../src/core/detect/detectTechnologies", () => ({
      detectTechnologies: jest.fn(() => [
        { slug: "Vue", name: "Vue", confidence: 80 },
        { slug: "React", name: "React", confidence: 90 },
      ]),
    }));

    jest.doMock("../src/core/report/enrichDetections", () => ({
      enrichDetections: jest.fn((_db, dets) =>
        dets.map((d) => ({
          ...d,
          categories: [{ id: 1, name: "Frontend" }],
          groups: [{ id: 1, name: "JS" }],
        })),
      ),
    }));

    jest.doMock("../src/core/report/summarize", () => ({
      buildSummary: jest.fn(() => ({ totalDetections: 2 })),
    }));
    jest.doMock("../src/core/report/groupDetections", () => ({
      groupDetections: jest.fn(() => ({ byCategory: {} })),
    }));
    jest.doMock("../src/core/report/recommendations", () => ({
      buildRecommendations: jest.fn(() => [{ hubspotProduct: "x" }]),
    }));

    // Ensure debugSignals off for this test
    jest.doMock("../src/core/config", () => ({
      config: { debugSignals: false },
    }));

    const { analyzeUrl } = require("../src/core/analyzer");
    const report = await analyzeUrl("https://example.com/");

    expect(report.ok).toBe(true);
    expect(report.url).toBe("https://example.com/");
    expect(report.finalUrl).toBe("https://example.com/");

    expect(report.detections.map((d) => d.name)).toEqual(["React", "Vue"]);
    expect(report.summary.totalDetections).toBe(2);
    expect(report.recommendations).toEqual([{ hubspotProduct: "x" }]);
    expect(report._debugSignals).toBeUndefined();
  });

  // ── htmlTruncated propagation ───────────────────────────────────────────────

  test("propagates htmlTruncated: true from fetchPage into the report", async () => {
    const db = { technologies: {} };

    jest.doMock("../src/core/techdb/loadTechDb", () => ({
      loadTechDb: jest.fn(async () => db),
    }));

    // Simulate fetchPage returning htmlTruncated: true (page exceeded byte cap)
    jest.doMock("../src/core/fetch/fetchPage", () => ({
      fetchPage: jest.fn(async () => ({
        timingMs: 3,
        finalUrl: "https://big-site.com/",
        status: 200,
        contentType: "text/html",
        bytes: 2_000_000,
        headers: {},
        html: "<html>…partial…</html>",
        external: { scripts: [], stylesheets: [] },
        htmlTruncated: true,
      })),
    }));

    jest.doMock("../src/core/normalize/signals", () => ({
      buildSignals: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/detect/detectTechnologies", () => ({
      detectTechnologies: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/enrichDetections", () => ({
      enrichDetections: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/summarize", () => ({
      buildSummary: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/groupDetections", () => ({
      groupDetections: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/recommendations", () => ({
      buildRecommendations: jest.fn(() => []),
    }));
    jest.doMock("../src/core/config", () => ({
      config: { debugSignals: false },
    }));

    const { analyzeUrl } = require("../src/core/analyzer");
    const report = await analyzeUrl("https://big-site.com/");

    expect(report.htmlTruncated).toBe(true);
  });

  test("sets htmlTruncated: false when fetchPage does not signal truncation", async () => {
    const db = { technologies: {} };

    jest.doMock("../src/core/techdb/loadTechDb", () => ({
      loadTechDb: jest.fn(async () => db),
    }));

    // fetchPage returns no htmlTruncated field — should default to false in report
    jest.doMock("../src/core/fetch/fetchPage", () => ({
      fetchPage: jest.fn(async () => ({
        timingMs: 3,
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/html",
        bytes: 50_000,
        headers: {},
        html: "<html></html>",
        external: { scripts: [], stylesheets: [] },
        // htmlTruncated intentionally absent
      })),
    }));

    jest.doMock("../src/core/normalize/signals", () => ({
      buildSignals: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/detect/detectTechnologies", () => ({
      detectTechnologies: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/enrichDetections", () => ({
      enrichDetections: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/summarize", () => ({
      buildSummary: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/groupDetections", () => ({
      groupDetections: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/recommendations", () => ({
      buildRecommendations: jest.fn(() => []),
    }));
    jest.doMock("../src/core/config", () => ({
      config: { debugSignals: false },
    }));

    const { analyzeUrl } = require("../src/core/analyzer");
    const report = await analyzeUrl("https://example.com/");

    expect(report.htmlTruncated).toBe(false);
  });

  test("includes _debugSignals only when enabled via config", async () => {
    const db = { technologies: {} };

    jest.doMock("../src/core/techdb/loadTechDb", () => ({
      loadTechDb: jest.fn(async () => db),
    }));
    jest.doMock("../src/core/fetch/fetchPage", () => ({
      fetchPage: jest.fn(async () => ({
        timingMs: 1,
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/html",
        bytes: 1,
        headers: { "set-cookie": ["a=b"] },
        html: "<html></html>",
        external: { scripts: [], stylesheets: [] },
      })),
    }));
    jest.doMock("../src/core/normalize/signals", () => ({
      buildSignals: jest.fn(() => ({
        meta: { a: "b" },
        scriptSrc: ["x"],
        cookies: ["a"],
      })),
    }));
    jest.doMock("../src/core/detect/detectTechnologies", () => ({
      detectTechnologies: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/enrichDetections", () => ({
      enrichDetections: jest.fn(() => []),
    }));
    jest.doMock("../src/core/report/summarize", () => ({
      buildSummary: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/groupDetections", () => ({
      groupDetections: jest.fn(() => ({})),
    }));
    jest.doMock("../src/core/report/recommendations", () => ({
      buildRecommendations: jest.fn(() => []),
    }));

    jest.doMock("../src/core/config", () => ({
      config: { debugSignals: true },
    }));

    const { analyzeUrl } = require("../src/core/analyzer");
    const report = await analyzeUrl("https://example.com/");

    expect(report._debugSignals).toEqual({
      metaKeys: ["a"],
      scriptSrcPreview: ["x"],
      cookieNames: ["a"],
    });
  });
});
