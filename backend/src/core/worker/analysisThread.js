// backend/src/core/worker/analysisThread.js
//
// The code that runs inside the analysis worker thread, which runAnalysis.js
// starts. The thread keeps its own copy of the dataset and analyzes one
// fetched page per message.
const { parentPort } = require("node:worker_threads");
const { analyzeFetched, initTechDb } = require("../analyzeFetched");

// Load the dataset now rather than on the first job. initTechDb logs a
// failure, and the next job tries again.
initTechDb().catch(() => {});

parentPort.on("message", async (fetched) => {
  try {
    const db = await initTechDb();
    parentPort.postMessage({ ok: true, result: analyzeFetched(db, fetched) });
  } catch (err) {
    // An Error that crosses threads loses its name and custom fields, and a
    // thrown non-Error might not cross at all, so send plain strings.
    parentPort.postMessage({
      ok: false,
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
});
