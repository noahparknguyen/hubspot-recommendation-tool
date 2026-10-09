/**
 * Unit tests for the readBodyWithLimit truncation behaviour inside fetchPage.js.
 *
 * readBodyWithLimit is not exported directly, so we test it through fetchPage
 * by providing a fake global fetch that returns a streaming response body.
 * This verifies the complete observable contract without reaching the real network.
 *
 * Covers:
 * - Normal response under the byte cap: body returned in full, truncated: false
 * - Response exactly at the byte cap: body returned in full, truncated: false
 * - Response one byte over the cap: body truncated at cap, truncated: true
 * - Chunk straddles the cap boundary: only the fitting portion is kept
 * - Multiple chunks, cap reached mid-stream: later chunks ignored
 * - Unreadable body (no getReader): throws FETCH_UNREADABLE_BODY AppError
 * - htmlTruncated: true appears in the fetchPage return object when truncated
 * - htmlTruncated: false appears in the fetchPage return object when not truncated
 *
 * Each test mocks the global fetch and the SSRF assertPublicHost check so that
 * no real network calls are made and private-host blocking is bypassed.
 */

/**
 * Build a minimal Web Streams-compatible ReadableStream from an array of
 * Uint8Array chunks. Node's fetch/undici exposes a `getReader()` method that
 * returns an object with `read()` returning `{ done, value }` pairs.
 */
function makeStreamFromChunks(chunks) {
  let idx = 0;
  return {
    getReader() {
      return {
        async read() {
          if (idx >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[idx++] };
        },
      };
    },
  };
}

/**
 * Build a mock fetch response with the given body chunks and status.
 * The response also has a minimal headers implementation that fetchPage reads.
 */
function makeFakeResponse(chunks, status = 200) {
  const headers = new Map([["content-type", "text/html"]]);
  return {
    status,
    statusText: "OK",
    headers: {
      entries: () => headers.entries(),
      get: (k) => headers.get(k) ?? null,
      getSetCookie: () => [],
    },
    body: makeStreamFromChunks(chunks),
  };
}

describe("readBodyWithLimit (via fetchPage)", () => {
  let originalFetch;

  beforeEach(() => {
    jest.resetModules();
    originalFetch = global.fetch;

    // Bypass SSRF checks — we're testing body reading, not host validation
    jest.doMock("../src/core/fetch/ssrf", () => ({
      assertPublicHost: jest.fn(async () => {}),
    }));
    // Use a permissive config so timeouts don't interfere with fast unit tests
    jest.doMock("../src/core/config", () => ({
      config: { fetch: { timeoutMs: 30_000, maxBytes: 100 } },
    }));
    // fetchPage calls undici's fetch: route it to the fake each test sets
    jest.doMock("undici", () => ({
      Agent: function Agent() {},
      fetch: (...args) => global.fetch(...args),
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function load() {
    return require("../src/core/fetch/fetchPage");
  }

  // ── Under the cap ─────────────────────────────────────────────────────────

  test("returns full body and truncated: false when response is under maxBytes", async () => {
    const body = Buffer.from("Hello, world!");
    global.fetch = jest.fn(async () =>
      makeFakeResponse([new Uint8Array(body)]),
    );

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 100 });

    expect(result.html).toBe("Hello, world!");
    expect(result.htmlTruncated).toBe(false);
  });

  test("returns full body and truncated: false when response is exactly maxBytes", async () => {
    const body = Buffer.from("A".repeat(100));
    global.fetch = jest.fn(async () =>
      makeFakeResponse([new Uint8Array(body)]),
    );

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 100 });

    expect(result.html).toBe("A".repeat(100));
    expect(result.htmlTruncated).toBe(false);
    expect(result.bytes).toBe(100);
  });

  // ── Over the cap ──────────────────────────────────────────────────────────

  test("truncates body and sets truncated: true when response exceeds maxBytes", async () => {
    // 150 bytes but cap is 100 — should return exactly 100 bytes
    const body = Buffer.from("B".repeat(150));
    global.fetch = jest.fn(async () =>
      makeFakeResponse([new Uint8Array(body)]),
    );

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 100 });

    expect(result.html).toBe("B".repeat(100));
    expect(result.html).toHaveLength(100);
    expect(result.htmlTruncated).toBe(true);
  });

  test("truncates correctly when chunk straddles the cap boundary", async () => {
    // First chunk: 60 bytes. Second chunk: 60 bytes. Cap: 100.
    // Only the first 40 bytes of the second chunk should be kept.
    const chunk1 = new Uint8Array(Buffer.from("X".repeat(60)));
    const chunk2 = new Uint8Array(Buffer.from("Y".repeat(60)));
    global.fetch = jest.fn(async () => makeFakeResponse([chunk1, chunk2]));

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 100 });

    expect(result.html).toBe("X".repeat(60) + "Y".repeat(40));
    expect(result.html).toHaveLength(100);
    expect(result.htmlTruncated).toBe(true);
  });

  test("ignores all chunks after cap is reached (multiple-chunk stream)", async () => {
    // Cap is 50. Stream has 5 chunks of 20 bytes each (100 total).
    // Only the first 2 full chunks (40 bytes) + 10 bytes of chunk 3 should survive.
    const chunks = Array.from(
      { length: 5 },
      () => new Uint8Array(Buffer.from("Z".repeat(20))),
    );
    global.fetch = jest.fn(async () => makeFakeResponse(chunks));

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 50 });

    expect(result.html).toHaveLength(50);
    expect(result.html).toBe("Z".repeat(50));
    expect(result.htmlTruncated).toBe(true);
  });

  // ── htmlTruncated on the fetchPage return object ──────────────────────────

  test("fetchPage result carries htmlTruncated: false for a normal response", async () => {
    global.fetch = jest.fn(async () =>
      makeFakeResponse([new Uint8Array(Buffer.from("ok"))]),
    );

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 100 });

    expect(Object.prototype.hasOwnProperty.call(result, "htmlTruncated")).toBe(
      true,
    );
    expect(result.htmlTruncated).toBe(false);
  });

  test("fetchPage result carries htmlTruncated: true when HTML is cut short", async () => {
    const oversized = new Uint8Array(Buffer.from("A".repeat(200)));
    global.fetch = jest.fn(async () => makeFakeResponse([oversized]));

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/", { maxBytes: 100 });

    expect(result.htmlTruncated).toBe(true);
  });

  // ── Error case ────────────────────────────────────────────────────────────

  test("throws FETCH_UNREADABLE_BODY AppError when response.body has no getReader", async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: {
        entries: () => new Map().entries(),
        get: () => null,
        getSetCookie: () => [],
      },
      body: null, // no getReader — simulates an unreadable body
    }));

    const { fetchPage } = load();

    await expect(
      fetchPage("https://example.com/", { maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: "FETCH_UNREADABLE_BODY",
    });
  });
});
