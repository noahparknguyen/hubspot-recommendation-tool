/**
 * Tests the server's last-resort error handling, by running the real
 * server.js in a child process with the analyze route swapped for a broken one.
 *
 * Covers:
 * - A route that throws after it started responding gets its connection cut,
 *   and the server keeps running (it used to exit on ERR_HTTP_HEADERS_SENT)
 */
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const backend = path.join(__dirname, "..");
const routeFile = path.join(backend, "src/api/routes/analyze.js");
const serverFile = path.join(backend, "src/api/server.js");

// Puts a stand-in for the analyze route into the module cache, so server.js
// loads it instead of the real one. It starts a response, then throws.
const childCode = `
  require.cache[${JSON.stringify(routeFile)}] = {
    id: ${JSON.stringify(routeFile)},
    filename: ${JSON.stringify(routeFile)},
    loaded: true,
    exports: {
      handleAnalyze: async (_req, res) => {
        res.statusCode = 200;
        res.write("partial");
        throw new Error("broken after responding");
      },
    },
  };
  require(${JSON.stringify(serverFile)});
`;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe("api/server error handling", () => {
  let child;

  afterEach(() => {
    if (child) child.kill();
  });

  test("cuts the connection when a route throws after responding, and keeps running", async () => {
    const port = await freePort();
    child = spawn(process.execPath, ["-e", childCode], {
      cwd: backend,
      env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
    });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        if (String(d).includes("listening")) resolve();
      });
      child.on("exit", (code) =>
        reject(new Error(`server exited with code ${code}`)),
      );
    });
    const base = `http://127.0.0.1:${port}`;

    await expect(
      fetch(`${base}/api/analyze?url=https://example.com`).then((r) =>
        r.text(),
      ),
    ).rejects.toThrow();

    // Give a crashing server time to exit before checking it's still up.
    await new Promise((r) => setTimeout(r, 200));
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(child.exitCode).toBeNull();
  }, 15_000);
});
