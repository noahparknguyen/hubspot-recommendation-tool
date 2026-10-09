/**
 * Integration test for DNS rebinding through fetchPage, with a real fetch and
 * a real local server standing in for an internal service.
 *
 * DNS rebinding means a hostname answers the SSRF check with a public address
 * and the connection with a private one. Here the check's lookup
 * (dns.promises.lookup) answers 1.1.1.1, and the connection's lookup
 * (dns.lookup) answers 127.0.0.1, where the local server listens. The fetch
 * must be refused, and the server must never be reached.
 */
const http = require("node:http");
const dns = require("node:dns");

describe("fetchPage under DNS rebinding", () => {
  let server;
  let port;
  let requestsReceived;

  beforeAll(async () => {
    requestsReceived = 0;
    server = http.createServer((_req, res) => {
      requestsReceived++;
      res.end("<html>internal</html>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("refuses a host whose connection resolves to a private address", async () => {
    jest
      .spyOn(dns.promises, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    jest
      .spyOn(dns, "lookup")
      .mockImplementation((_host, _opts, cb) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }]),
      );

    const { fetchPage } = require("../src/core/fetch/fetchPage");

    await expect(
      fetchPage(`http://rebind.test:${port}/`, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED_IP", statusCode: 400 });
    expect(requestsReceived).toBe(0);
  });
});
