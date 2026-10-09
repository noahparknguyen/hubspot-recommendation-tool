/**
 * Unit tests for the fetch deadline and redirect handling inside fetchPage.js.
 *
 * Like readBodyWithLimit.test.js, these drive fetchPage through a fake global
 * fetch, with the SSRF check mocked out, so no real network calls are made.
 *
 * Covers:
 * - A body that stalls after the headers times out at the deadline
 * - A redirect's body is cancelled before the next hop is followed
 */

/** A body that sends its first chunk, then waits until the request is aborted. */
function makeStallingBody(firstChunk, signal) {
  let sent = false;
  return {
    getReader() {
      return {
        read() {
          if (!sent) {
            sent = true;
            return Promise.resolve({ done: false, value: firstChunk });
          }
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
      };
    },
  };
}

function makeBody(chunks) {
  let idx = 0;
  return {
    cancel: jest.fn(async () => {}),
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

function makeResponse({ status = 200, headers = {}, body }) {
  const map = new Map(Object.entries(headers));
  return {
    status,
    statusText: "",
    headers: {
      entries: () => map.entries(),
      get: (k) => map.get(k) ?? null,
      getSetCookie: () => [],
    },
    body,
  };
}

describe("fetchPage deadline and redirects", () => {
  let originalFetch;

  beforeEach(() => {
    jest.resetModules();
    originalFetch = global.fetch;
    jest.doMock("../src/core/fetch/ssrf", () => ({
      assertPublicHost: jest.fn(async () => {}),
    }));
    jest.doMock("../src/core/config", () => ({
      config: { fetch: { timeoutMs: 30_000, maxBytes: 100_000 } },
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function load() {
    return require("../src/core/fetch/fetchPage");
  }

  test("times out when the body stalls after the headers", async () => {
    global.fetch = jest.fn(async (_url, opts) =>
      makeResponse({
        headers: { "content-type": "text/html" },
        body: makeStallingBody(
          new Uint8Array(Buffer.from("<html>")),
          opts.signal,
        ),
      }),
    );

    const { fetchPage } = load();
    const start = Date.now();

    await expect(
      fetchPage("https://example.com/", { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "FETCH_TIMEOUT", statusCode: 504 });
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("cancels a redirect's body before following it", async () => {
    const redirectBody = makeBody([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          status: 302,
          headers: { location: "https://example.com/next" },
          body: redirectBody,
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          headers: { "content-type": "text/html" },
          body: makeBody([new Uint8Array(Buffer.from("<html></html>"))]),
        }),
      );

    const { fetchPage } = load();
    const result = await fetchPage("https://example.com/");

    expect(redirectBody.cancel).toHaveBeenCalledTimes(1);
    expect(result.finalUrl).toBe("https://example.com/next");
    expect(result.html).toBe("<html></html>");
  });
});
