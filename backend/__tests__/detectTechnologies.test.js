/**
 * Unit tests for Phase 4: Technology Detection (detectTechnologies).
 *
 * We mock the 10 matcher modules to precisely control inputs and verify:
 * - confidence aggregation uses the probabilistic OR formula (bounded to [0,100])
 * - version comes from the strongest single evidence match
 * - evidence is de-duped and capped
 * - matchers throwing does NOT crash detection (defensive pipeline), and the
 *   failing matcher is logged by name
 * - filtering by minConfidence happens AFTER relationship resolution
 */
describe("core/detect/detectTechnologies", () => {
  const mkDb = () => ({
    technologies: {
      React: { name: "React" },
      "Next.js": { name: "Next.js" },
    },
  });

  beforeEach(() => {
    jest.resetModules();
  });

  function mockAllMatchers(impls) {
    jest.doMock("../src/core/detect/matchers/url", () => ({
      matchUrl: impls.url || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/headers", () => ({
      matchHeaders: impls.headers || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/cookies", () => ({
      matchCookies: impls.cookies || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/meta", () => ({
      matchMeta: impls.meta || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/html", () => ({
      matchHtml: impls.html || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/text", () => ({
      matchText: impls.text || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/scriptSrc", () => ({
      matchScriptSrc: impls.scriptSrc || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/scripts", () => ({
      matchScripts: impls.scripts || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/css", () => ({
      matchCss: impls.css || (() => []),
    }));
    jest.doMock("../src/core/detect/matchers/dom", () => ({
      matchDom: impls.dom || (() => []),
    }));
  }

  test("aggregates confidence across matchers and prefers version from strongest evidence", () => {
    mockAllMatchers({
      url: () => [
        {
          slug: "React",
          confidence: 60,
          version: "18.0.0",
          evidence: "url hit",
        },
      ],
      headers: () => [
        {
          slug: "React",
          confidence: 30,
          version: "17.0.2",
          evidence: "header hit",
        },
      ],
      // another technology
      html: () => [{ slug: "Next.js", confidence: 55, evidence: "html hit" }],
    });

    // relationship resolvers: identity (no changes)
    jest.doMock("../src/core/detect/resolve/requires", () => ({
      resolveRequires: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/implies", () => ({
      resolveImplies: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/excludes", () => ({
      resolveExcludes: (x) => x,
    }));

    const {
      detectTechnologies,
    } = require("../src/core/detect/detectTechnologies");
    const out = detectTechnologies(mkDb(), {});

    // React confidence: OR(0.60, 0.30) = 1 - 0.4*0.7 = 0.72 => 72
    const react = out.find((d) => d.slug === "React");
    expect(react.confidence).toBe(72);

    // Version should come from strongest single evidence match (60 beats 30)
    expect(react.version).toBe("18.0.0");

    // Evidence is collected and de-duped
    expect(react.evidence).toEqual(["url hit", "header hit"]);

    const next = out.find((d) => d.slug === "Next.js");
    expect(next.confidence).toBe(55);
  });

  test("does not crash when a matcher throws, and logs which one", () => {
    const boom = new Error("boom");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockAllMatchers({
      url: function matchUrl() {
        throw boom;
      },
      html: () => [{ slug: "React", confidence: 80, evidence: "html ok" }],
    });

    jest.doMock("../src/core/detect/resolve/requires", () => ({
      resolveRequires: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/implies", () => ({
      resolveImplies: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/excludes", () => ({
      resolveExcludes: (x) => x,
    }));

    const {
      detectTechnologies,
    } = require("../src/core/detect/detectTechnologies");
    expect(() => detectTechnologies(mkDb(), {})).not.toThrow();
    const out = detectTechnologies(mkDb(), {});
    expect(out).toEqual([
      { slug: "React", name: "React", confidence: 80, evidence: ["html ok"] },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[detect] matchUrl threw; its detections were skipped:",
      boom,
    );
  });

  test("applies minConfidence AFTER relationship resolution", () => {
    mockAllMatchers({
      html: () => [{ slug: "React", confidence: 40, evidence: "weak" }],
    });

    // Resolver bumps confidence above threshold (simulates implies/requires boosting by adding detections)
    jest.doMock("../src/core/detect/resolve/requires", () => ({
      resolveRequires: (arr) =>
        arr.map((d) => (d.slug === "React" ? { ...d, confidence: 55 } : d)),
    }));
    jest.doMock("../src/core/detect/resolve/implies", () => ({
      resolveImplies: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/excludes", () => ({
      resolveExcludes: (x) => x,
    }));

    const {
      detectTechnologies,
    } = require("../src/core/detect/detectTechnologies");
    const out = detectTechnologies(mkDb(), {}, { minConfidence: 50 });

    // React should survive because resolver increased confidence before filter
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(55);
  });

  test("throws a clear error if DB is not loaded", () => {
    mockAllMatchers({});
    jest.doMock("../src/core/detect/resolve/requires", () => ({
      resolveRequires: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/implies", () => ({
      resolveImplies: (x) => x,
    }));
    jest.doMock("../src/core/detect/resolve/excludes", () => ({
      resolveExcludes: (x) => x,
    }));

    const {
      detectTechnologies,
    } = require("../src/core/detect/detectTechnologies");
    expect(() => detectTechnologies(null, {})).toThrow("Tech DB is not loaded");
  });
});
