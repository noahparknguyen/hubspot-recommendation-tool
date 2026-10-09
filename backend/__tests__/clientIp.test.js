/**
 * Unit tests for api/clientIp: the address a request is counted under by the
 * auth and analysis limits.
 *
 * Covers:
 * - With no trusted proxies (the default), X-Forwarded-For and X-Real-IP are ignored
 * - Behind proxies, the entry the outermost proxy added is used, whatever the
 *   client put before it
 * - A header shorter than the proxy count falls back to the connection's address
 * - The proxy count defaults to TRUST_PROXY_HOPS
 */
describe("api/clientIp - getClientIp", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function req(headers, remoteAddress = "10.0.0.5") {
    return { headers, socket: { remoteAddress } };
  }

  // What a Render service receives when a client at 203.0.113.7 sends
  // "X-Forwarded-For: 192.0.2.66": the client's own value, then one entry each
  // from Cloudflare and two Render proxies. Measured on Render, with the
  // addresses swapped for documentation ones.
  const renderForged = "192.0.2.66,203.0.113.7, 172.70.50.143, 10.31.183.61";

  test("ignores client-supplied headers when no proxies are trusted", () => {
    const { getClientIp } = require("../src/api/clientIp");

    expect(
      getClientIp(
        req({ "x-forwarded-for": renderForged, "x-real-ip": "192.0.2.77" }),
        0,
      ),
    ).toBe("10.0.0.5");
  });

  test("uses the entry the outermost proxy added, whatever the client sent", () => {
    const { getClientIp } = require("../src/api/clientIp");
    const proxies = "203.0.113.7, 172.70.50.143, 10.31.183.61";

    expect(getClientIp(req({ "x-forwarded-for": renderForged }), 3)).toBe(
      "203.0.113.7",
    );
    expect(
      getClientIp(
        req({ "x-forwarded-for": `192.0.2.1, 192.0.2.2, ${proxies}` }),
        3,
      ),
    ).toBe("203.0.113.7");
    expect(getClientIp(req({ "x-forwarded-for": proxies }), 3)).toBe(
      "203.0.113.7",
    );
    expect(
      getClientIp(req({ "x-forwarded-for": "192.0.2.66, 203.0.113.7" }), 1),
    ).toBe("203.0.113.7");
  });

  test("falls back to the connection's address when the header is too short", () => {
    const { getClientIp } = require("../src/api/clientIp");

    expect(
      getClientIp(req({ "x-forwarded-for": "192.0.2.66, 10.31.183.61" }), 3),
    ).toBe("10.0.0.5");
    expect(getClientIp(req({}), 3)).toBe("10.0.0.5");
    expect(getClientIp({ headers: {} }, 0)).toBe("unknown");
  });

  test("takes the proxy count from TRUST_PROXY_HOPS by default", () => {
    jest.doMock("../src/core/config", () => ({
      config: { http: { trustProxyHops: 3 } },
    }));
    const { getClientIp } = require("../src/api/clientIp");

    expect(getClientIp(req({ "x-forwarded-for": renderForged }))).toBe(
      "203.0.113.7",
    );
  });
});
