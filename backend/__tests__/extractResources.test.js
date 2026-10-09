/**
 * Unit tests for how fetchPage finds a page's external scripts and stylesheets.
 *
 * Driven through fetchPage with a fake fetch, which serves the page and then
 * records every external URL fetchPage asks for. The SSRF check is mocked out.
 *
 * Covers:
 * - Script src values: double-quoted, single-quoted, unquoted, any case
 * - Lookalike tags (<scripts>) are not scripts
 * - Stylesheet links in either attribute order, with extra rel tokens
 * - Links that aren't stylesheets are skipped
 * - Crafted pages that made the old regexes backtrack finish quickly
 */

function makeResponse(body) {
  const headers = new Map([["content-type", "text/html"]]);
  let sent = false;
  return {
    status: 200,
    statusText: "OK",
    headers: {
      entries: () => headers.entries(),
      get: (k) => headers.get(k) ?? null,
      getSetCookie: () => [],
    },
    body: {
      getReader: () => ({
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: new Uint8Array(Buffer.from(body)) };
        },
      }),
    },
  };
}

describe("fetchPage external resource discovery", () => {
  let originalFetch;
  let requested;

  beforeEach(() => {
    jest.resetModules();
    originalFetch = global.fetch;
    requested = [];
    jest.doMock("../src/core/fetch/ssrf", () => ({
      assertPublicHost: jest.fn(async () => {}),
    }));
    jest.doMock("../src/core/config", () => ({
      config: { fetch: { timeoutMs: 30_000, maxBytes: 3_000_000 } },
    }));
    jest.doMock("undici", () => ({
      Agent: function Agent() {},
      fetch: (...args) => global.fetch(...args),
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function servePage(html) {
    global.fetch = jest.fn(async (url) => {
      if (url === "https://example.com/") return makeResponse(html);
      requested.push(url);
      return makeResponse("");
    });
    return require("../src/core/fetch/fetchPage").fetchPage(
      "https://example.com/",
    );
  }

  test("finds script sources in every quoting style and case", async () => {
    await servePage(`
      <script src="/double.js"></script>
      <script src='/single.js'></script>
      <script defer src=/unquoted.js></script>
      <SCRIPT SRC="/upper.js"></SCRIPT>
      <scripts src="/not-a-script.js"></scripts>
      <script>inline()</script>
    `);

    expect(requested.sort()).toEqual(
      [
        "https://example.com/double.js",
        "https://example.com/single.js",
        "https://example.com/unquoted.js",
        "https://example.com/upper.js",
      ].sort(),
    );
  });

  test("finds stylesheet links in either attribute order, and skips other links", async () => {
    await servePage(`
      <link rel="stylesheet" href="/a.css">
      <link href="/b.css" rel="Stylesheet">
      <link rel="preload stylesheet" href="/c.css">
      <link rel="icon" href="/favicon.ico">
    `);

    expect(requested.sort()).toEqual(
      [
        "https://example.com/a.css",
        "https://example.com/b.css",
        "https://example.com/c.css",
      ].sort(),
    );
  });

  test.each([
    ["unclosed <script fragments", "<script ".repeat(260_000)],
    ["unclosed <link fragments", "<link ".repeat(330_000)],
    ["unclosed <link href fragments", "<link href='a' ".repeat(130_000)],
  ])("finishes a 2 MB page of %s quickly", async (_label, html) => {
    const start = Date.now();
    await servePage(html);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
