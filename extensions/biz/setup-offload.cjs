'use strict';
// The managed setup runs `mise run dist:*` with execFileSync: seconds to minutes in which the thread that runs it
// answers nothing. In the gateway that thread also answers the framework's readiness probe (and the panel's
// forward-auth), so a long apply made `ext-biz-login` "not ready" and the framework's own post-apply wait for it
// timed out ("Extension processes not ready: ext-biz-login"). The long operations therefore run in a worker thread,
// one per call: the gateway's event loop keeps serving while the worker blocks on its subprocesses.
//
// What stays the same as running them in the gateway:
// - One change at a time: the worker builds the real setup, whose `exclusive` wrapper takes the same file lock
//   (`setup.lock` in the data dir) as the sync workflow and the CLI, so a second request while one runs is answered
//   `busy` right away. Nothing queues here.
// - The routes see the same errors: `message`, `status`, `files` and `detail` survive; `cause`, `stderr` and anything
//   else stay in the worker. They are redacted again on the way out.
// - A SIGTERM ends the process and its threads together (no handler); `shutdown()` is for a clean stop in code.
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');

/** The setup operations that run subprocesses for a long time. Everything else reads files and stays in the gateway. */
const LONG = ['preview', 'apply', 'publishPreview', 'publish', 'mergeAndPublish', 'sync'];

const running = new Set();

// Same redaction as the notices and the panel (tokens, age keys, machine paths), applied again at the boundary.
const tidy = (text, max) => require('./managed-setup.cjs').stderrTail({stderr: String(text)}, max);

/** What crosses from the worker: the fields the routes read, as plain values, redacted. Never the error itself. */
function failure(error) {
  const out = {message: tidy(error?.message ?? 'setup_failed', 200) || 'setup_failed'};
  if (Number.isInteger(error?.status)) out.status = error.status;
  if (Array.isArray(error?.files)) out.files = error.files.filter(file => typeof file === 'string').slice(0, 200).map(file => tidy(file, 300));
  if (typeof error?.detail === 'string' && error.detail) out.detail = tidy(error.detail, 500);
  if (typeof error?.code === 'string') out.code = tidy(error.code, 64);
  return out;
}

/**
 * `managed` with its long operations run in a worker thread that builds its own setup from the same environment.
 * The environment is the worker's `process.env` (a copy made by Node); it is never put in a message.
 * @param {object} managed the in-process setup (short operations are answered by it)
 * @param {{env: object, module?: string}} options `module` exports `setup(options)` (default managed-setup.cjs)
 */
function offload(managed, {env, module = require.resolve('./managed-setup.cjs')}) {
  const wrapped = {...managed};
  for (const name of LONG) {
    if (typeof managed[name] !== 'function') continue;
    wrapped[name] = (...args) => new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(__filename, {workerData: {module, name, args}, env: {...env}}); } catch { reject(Error('setup_worker_failed')); return; }
      running.add(worker);
      let settled = false;
      const done = (fn, value) => { if (!settled) { settled = true; running.delete(worker); fn(value); } };
      worker.once('message', message => done(message.ok ? resolve : reject, message.ok ? message.value : Object.assign(Error(message.error.message), message.error)));
      // An uncaught exception in the worker: its text is not forwarded (it could carry whatever the code printed).
      worker.once('error', () => done(reject, Error('setup_worker_failed')));
      // Exited without answering (a crash, process.exit, a terminate): a failure, never a hang.
      worker.once('exit', code => done(reject, Error(`setup_worker_exit_${code}`)));
    });
  }
  return wrapped;
}

/** Stop every running worker; their callers get `setup_worker_exit_1`. A half-done change stays for the next sync to settle. */
function shutdown() {
  return Promise.all([...running].map(worker => worker.terminate()));
}

if (!isMainThread && workerData?.module) {
  (async () => {
    try {
      const managed = require(workerData.module).setup({env: process.env});
      parentPort.postMessage({ok: true, value: await managed[workerData.name](...workerData.args)});
    } catch (error) {
      parentPort.postMessage({ok: false, error: failure(error)});
    }
  })();
}

module.exports = {offload, shutdown, LONG, failure};
