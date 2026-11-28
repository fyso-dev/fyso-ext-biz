# Test helpers

Shared fakes for the production seams (`tests/helpers.test.cjs` proves each one). Nothing here touches the
network, mise or the real clock. No file may spell a machine path out (`tests/machine-paths.test.cjs`): build
them at runtime, as `fake-runner.cjs` does.

```js
const {fakeBiz, fakeRunner, fakeClock, tempProject, harness, WINDOWS, CMD} = require('./helpers/index.cjs');
```

Specs live on the factories: `fakeBiz.http(503)`, `fakeBiz.hang()`, `fakeRunner.exit(3)`, `fakeRunner.CMD.publish`.

## fakeBiz: the `transport` of `projectAccess` and `auth.store`

```js
const biz = fakeBiz({scenario: 'member'});            // admin | member | noAccess | frozen | reauthorize
const access = projectAccess({env, transport: biz.fetch, now: clock.now});
biz.queue('report', fakeBiz.http(503));               // first report call: 503, then the default answer
await assert.rejects(access.report('tok'), {status: 503});
biz.scenario('admin').bumpEtag().publish('v3');       // state changes between calls
biz.count('report');                                  // calls per route: identity report decision recipient recipients setup.get setup.put oauth.*
biz.last('report').token;                             // call log: {route, method, path, query, headers, token, body, signal, outcome}
```

Scripts: `queue(route, ...specs)` one per call then back to default; `always(route, spec)`; `'*'` = any route;
`hold(route)` pauses calls until `gate.release()` (single-flight); `person(token, {scenario})` per-token report;
`revoke(token)` 401s. Specs: `ok(body)`, `http(status[, body])`, `reply(status, body, headers)`, `staleBase(current)`,
`versionConflict(current)`, `hang()` (honours the AbortSignal), `timedOut()` (immediate TimeoutError), `networkError()`.
Setup state: `biz.setup`, `biz.etag`, `biz.recipientList`, `biz.pendingRecipients(n)`, `biz.refreshRefused`.

## fakeRunner: the `run` and `sleep` of `managed-setup`'s `setup()`

```js
const runner = fakeRunner({root, plan: PLAN(), dryRun: DRY_RUN()});
const managed = setup({env, root, access, store, run: runner.run, sleep: runner.sleep});
runner.next(CMD.publish, fakeRunner.staleBase());     // first dist:publish exits 3 with the stale_base JSON
runner.always(CMD.update, fakeRunner.leaky(4));       // stderr full of machine paths and secrets
runner.count(CMD.snapshot); runner.last(CMD.key).env; // call log: {argv, args, env, cwd}
```

Failures: `exit(code, {stdout, stderr})`, `staleBase()` (3), `setupNotInstalled()` (5), `mergeConflict()` (4),
`failedChecks()`, `notPermitted()`, `oldFramework()`, `leaky()`, `nonJson()`. Matchers `CMD.key|plan|add|update|dryRun|publish|status|snapshot|extRemove|sopsDecrypt|sopsUnset`
(or a string/RegExp/function over `call.argv`).

## fakeClock: the `now` seam

```js
const clock = fakeClock(); clock.installAbortTimeout(t); // AbortSignal.timeout follows the clock
const access = projectAccess({env, transport: biz.fetch, now: clock.now});
clock.advance(WINDOWS.REPORT_FRESH_MS);                  // 30 s; also REPORT_STALE_MS, ACCESS_TIMEOUT_MS, CREDENTIAL_EXPIRY_MS, ...
```

## tempProject: a folder per test

```js
const project = tempProject(t);                          // removed by t.after; seeded with extensions biz/foo/bar, MCP, team, secrets
project.writeState({connected: true, version: 'v2'});    // .data/ext/biz/setup.json
project.makePublisher({commit: 'v3'});                   // .copier-answers.dist.yml + project/distribution.yaml (repo: biz)
setup({env: project.env, root: project.root, yaml: project.yaml});  // project.yaml: no `yaml` CLI needed
```

## harness: all of it wired

```js
const h = harness(t, {scenario: 'admin'});               // clock, project, biz, runner, access, store, managed
h.connect({version: 'v2', etag: 'e1'});
h.biz.publish('v3'); h.clock.advance(WINDOWS.REPORT_FRESH_MS);
assert.equal((await h.managed.sync()).status, 'applied');
```
