// backend/src/core/worker/runAnalysis.js
//
// Runs the CPU-bound half of an analysis (analyzeFetched.js) on a worker
// thread, under a time limit.
//
// Some dataset patterns backtrack badly: on a crafted page, one regex can run
// for minutes, and JavaScript can't interrupt a regex once it starts. On the
// main thread that would stall every request, health checks included. A
// worker thread can be stopped mid-regex with terminate(). So a job that runs
// past the limit is stopped and answered with a 504, and the next job gets a
// fresh thread.
//
// The thread runs one job at a time, and the rest wait here in arrival order.
// A job's clock starts when the thread takes it, so a slow job doesn't use up
// the time of the jobs queued behind it.
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { AppError } = require("../errors");
const { config } = require("../config");

const THREAD_FILE = path.join(__dirname, "analysisThread.js");

let worker = null; // the live thread, started on first use
let current = null; // the job it's running: { fetched, resolve, reject, timer }
const waiting = []; // jobs not started yet, oldest first

function timeoutError() {
  return new AppError({
    code: "ANALYSIS_TIMEOUT",
    message: "Analysis timed out",
    statusCode: 504,
    expose: true,
  });
}

/**
 * Starts the analysis thread, which begins loading the dataset straight away.
 * The server calls this at startup so the first request doesn't wait for the
 * load. runAnalysis starts the thread itself when there isn't one.
 *
 * @returns {void}
 */
function startAnalysisThread() {
  if (worker) return;

  const w = new Worker(THREAD_FILE);
  worker = w;

  w.on("message", (reply) => {
    if (w !== worker || !current) return; // a stopped thread's late reply
    finish((job) => {
      if (reply.ok) return job.resolve(reply.result);
      const err = new Error(reply.message);
      err.stack = reply.stack;
      job.reject(err);
    });
  });

  // A crash fires "error" and then "exit". Whichever arrives first fails the
  // running job, and the next job starts a new thread.
  w.on("error", (err) => crashed(w, err));
  w.on("exit", (code) =>
    crashed(w, new Error(`Analysis thread exited with code ${code}`)),
  );

  // An idle thread shouldn't keep a CLI run from exiting. While a job runs,
  // its timer keeps the process alive. This comes after the listeners,
  // because adding a "message" listener undoes it.
  w.unref();
}

/**
 * Runs phases 3-5 on a fetched page in the analysis thread.
 *
 * @param {object} fetched - Result of `fetchPage()`, copied to the thread
 * @returns {Promise<object>} The result of `analyzeFetched()`
 * @throws {AppError} 504 `ANALYSIS_TIMEOUT` when the job runs past `config.analysis.timeoutMs`
 */
function runAnalysis(fetched) {
  return new Promise((resolve, reject) => {
    waiting.push({ fetched, resolve, reject });
    startNext();
  });
}

function startNext() {
  if (current || waiting.length === 0) return;

  startAnalysisThread();
  current = waiting.shift();
  current.timer = setTimeout(timedOut, config.analysis.timeoutMs);
  worker.postMessage(current.fetched);
}

// Settles the running job, then starts the next one.
function finish(settle) {
  const job = current;
  current = null;
  clearTimeout(job.timer);
  settle(job);
  startNext();
}

function timedOut() {
  // Dropping the thread first means its "exit" event is ignored, and the next
  // job starts a fresh thread, which loads its own copy of the dataset.
  const stopped = worker;
  worker = null;
  stopped.terminate();
  finish((job) => job.reject(timeoutError()));
}

function crashed(w, err) {
  if (w !== worker) return; // already replaced
  worker = null;
  if (current) finish((job) => job.reject(err));
}

module.exports = { runAnalysis, startAnalysisThread };
