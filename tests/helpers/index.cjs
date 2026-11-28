'use strict';
// Shared test helpers. `const {fakeBiz, fakeRunner, fakeClock, tempProject, harness} = require('./helpers/index.cjs')`.
// See README.md in this folder for one example per helper.
const clock = require('./fake-clock.cjs');
const biz = require('./fake-biz.cjs');
const runner = require('./fake-runner.cjs');
const project = require('./temp-project.cjs');

/**
 * Everything wired together on the production seams, for a test `t` (node:test context):
 *   clock (fake `now`, abort timeouts follow it) -> temp project -> fake Biz -> projectAccess + auth.store
 *   -> managed setup (fake runner as `run`/`sleep`). The profile grant is saved, so
 *   `harness(t).managed.preview()` works at once. Call `h.connect()` to mark the setup connected (for `sync()`).
 * @param {{after: Function}} t node:test context
 * @param {object} [options]
 * @param {'admin'|'member'|'noAccess'|'frozen'|'reauthorize'} [options.scenario] Biz access scenario ('member')
 * @param {boolean} [options.grant] save the profile grant on disk (true)
 * @param {string|null} [options.setupVersion] setup Biz has ('v2'; null = none)
 * @param {object} [options.project] tempProject options  @param {object} [options.runner] fakeRunner options
 * @param {Function} [options.deliverTeams] managed teams delivery (default: nothing to deliver)
 */
function harness(t, {scenario = 'member', grant = true, setupVersion = 'v2', project: projectOptions = {}, runner: runnerOptions = {}, deliverTeams} = {}) {
  const {projectAccess} = require('../../extensions/biz/project-access.cjs');
  const {store} = require('../../extensions/biz/auth.cjs');
  const {setup} = require('../../extensions/biz/managed-setup.cjs');
  const fakeClock = clock.fakeClock();
  fakeClock.installAbortTimeout(t);
  const dir = project.tempProject(t, projectOptions);
  const fakeBizInstance = biz.fakeBiz({url: dir.env.FYSO_BIZ_URL, organization: dir.env.FYSO_BIZ_ACCESS_ORGANIZATION, scenario, clock: fakeClock, setupVersion});
  const fakeRun = runner.fakeRunner({root: dir.root, ...runnerOptions});
  if (grant) dir.writeProfileGrant({expiresAt: fakeClock.now() + fakeBizInstance.credentialExpiresIn * 1000});
  const access = projectAccess({env: dir.env, transport: fakeBizInstance.fetch, now: fakeClock.now, root: dir.root});
  const authStore = store({env: dir.env, transport: fakeBizInstance.fetch, now: fakeClock.now});
  const managed = setup({env: dir.env, root: dir.root, access, store: authStore, run: fakeRun.run, now: fakeClock.now, sleep: fakeRun.sleep,
    yaml: dir.yaml, deliverTeams: deliverTeams ?? (async () => ({managed: true, teams: []}))});
  return {clock: fakeClock, project: dir, env: dir.env, root: dir.root, biz: fakeBizInstance, runner: fakeRun, access, store: authStore, managed,
    /** Mark the setup connected (what a confirmed first connect leaves) so `managed.sync()` runs; extra keys merge into the state. */
    connect: (state = {}) => dir.patchState({connected: true, ...state})};
}

// Spec builders live on the factories to avoid name clashes: fakeBiz.http(503), fakeBiz.hang(), fakeRunner.exit(3), fakeRunner.CMD.publish.
module.exports = {fakeClock: clock.fakeClock, WINDOWS: clock.WINDOWS, fakeBiz: biz.fakeBiz, fakeRunner: runner.fakeRunner, tempProject: project.tempProject, miniYaml: project.miniYaml, harness,
  CMD: runner.CMD, AGE_KEY: runner.AGE_KEY, PLAN: runner.PLAN, DRY_RUN: runner.DRY_RUN, PUBLISHED: runner.PUBLISHED, MACHINE_PATHS: runner.MACHINE_PATHS, SECRETS: runner.SECRETS};
