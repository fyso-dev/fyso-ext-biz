'use strict';
// A project folder in os.tmpdir() per test, removed by `t.after`, with writers/readers for the files
// the extension reads: setup.json, .copier-answers.dist.yml, project/distribution.yaml and friends.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const STATE_FILE = 'setup.json';

const scalar = text => {
  const value = text.replace(/\s+#.*$/, '').trim();
  if (value === 'true' || value === 'false') return value === 'true';
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
};
/**
 * A stand-in for the `yaml` library managed-setup gets from the mise-installed CLI (`yaml: ...` seam of
 * `setup()` / `inspect()`), so tests do not need that CLI on PATH. It reads only what the extension
 * reads: top-level `key: value` pairs, a top-level list of `- key: value` items (project/bots/team.yaml),
 * and nothing else (nested maps come back as raw strings).
 */
const miniYaml = {
  parse(text) {
    const out = {};
    let list = null, item = null;
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const pair = /^(-\s+)?([^:\s][^:]*):\s*(.*)$/.exec(line);
      if (!/^\s/.test(raw)) {
        if (!pair) continue;
        list = pair[3] === '' ? (out[pair[2]] = []) : null;
        if (!list) out[pair[2]] = scalar(pair[3]);
      } else if (pair?.[1]) { item = {[pair[2]]: scalar(pair[3])}; list?.push(item); }
      else if (pair && item) item[pair[2]] = scalar(pair[3]);
    }
    return out;
  },
};

/**
 * @param {{after: Function}|null} t the node:test context (`test('x', t => ...)`); null = call `project.cleanup()` yourself
 * @param {object} [options]
 * @param {boolean} [options.seed] true (default): the extensions biz/foo/bar, an MCP file with `mine` and `fromsetup`, a team file with
 *   bots Mine and Shared and a delivered secrets file (API_KEY, OTHER). false: an empty folder.
 * @param {string} [options.organization] FYSO_BIZ_ACCESS_ORGANIZATION ('acme')
 * @param {string} [options.bizUrl] FYSO_BIZ_URL ('https://biz.test')
 * @param {object} [options.env] extra or overriding environment variables
 */
function tempProject(t, {seed = true, organization = 'acme', bizUrl = 'https://biz.test', env: extraEnv = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-test-'));
  const data = path.join(root, '.data');
  // Department mode (no FYSO_BIZ_ACCESS_PROJECT). Pass `env: {FYSO_BIZ_ACCESS_PROJECT: 'p'}` for project mode.
  const env = {FYSO_DATA: data, FYSO_BIZ_ACCESS_ORGANIZATION: organization, FYSO_BIZ_URL: bizUrl,
    FYSO_WEB_DOMAIN: 'demo.test', FYSO_WEB_SCHEME: 'https', FYSO_HTTP_PORT: '6100', FYSO_PROJECT: 'demo', ...extraEnv};
  const abs = rel => path.join(root, rel);
  const bizDir = path.join(data, 'ext', 'biz'); // auth.dataDir(env)

  const project = {
    /** Absolute project root: pass as `root`. */
    root,
    /** Environment for `setup({env})`, `projectAccess({env})`, `store({env})`, `profileSessions({env})`. */
    env,
    /** The extension's runtime folder (`.data/ext/biz`): setup.json, profile-oauth.json, setup.lock live here. */
    dataDir: bizDir,
    path: abs,
    /** Pass as `yaml` to `setup()` / `inspect()` when the `yaml` CLI is not on PATH (see miniYaml). */
    yaml: miniYaml,
    cleanup: () => fs.rmSync(root, {recursive: true, force: true}),

    /** Write any file under the root (folders created). Returns its absolute path. */
    writeFile(rel, content) {
      fs.mkdirSync(path.dirname(abs(rel)), {recursive: true});
      fs.writeFileSync(abs(rel), typeof content === 'string' ? content : JSON.stringify(content));
      return abs(rel);
    },
    readFile(rel) { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } },
    exists: rel => fs.existsSync(abs(rel)),
    /** Relative names directly under `rel` (default the root), sorted. */
    list: (rel = '.') => fs.readdirSync(abs(rel)).sort(),

    // setup.json: the managed-setup state (`readState`/`writeState` of managed-setup.cjs read the same file).
    stateFile: path.join(bizDir, STATE_FILE),
    /** Replace the whole state, e.g. `{connected: true, version: 'v2', etag: 'e1'}`. */
    writeState(state) {
      fs.mkdirSync(bizDir, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(bizDir, STATE_FILE), JSON.stringify(state), {mode: 0o600});
    },
    /** The parsed state, `{}` when there is none. */
    readState() { try { return JSON.parse(fs.readFileSync(path.join(bizDir, STATE_FILE), 'utf8')); } catch { return {}; } },
    /** Merge keys into the state. */
    patchState(patch) { project.writeState({...project.readState(), ...patch}); },

    // .copier-answers.dist.yml: what the distribution recorded as installed (`_commit`).
    /** Mark the distribution as installed at `commit` (default 'v2'). */
    writeAnswers({commit = 'v2', src = 'biz'} = {}) {
      project.writeFile('.copier-answers.dist.yml', `_commit: ${commit}\n_src_path: ${src}\n`);
    },
    readAnswers: () => project.readFile('.copier-answers.dist.yml'),
    /** The version recorded in the answers file, or null. */
    answersVersion: () => /^_commit:\s*['"]?(v\d+(?:\.\d+){0,2})['"]?\s*$/m.exec(project.readAnswers() ?? '')?.[1] ?? null,

    // project/distribution.yaml: `repo: biz` makes this project a publisher.
    writeDistribution({repo = 'biz'} = {}) { project.writeFile('project/distribution.yaml', `repo: ${repo}\n`); },
    readDistribution: () => project.readFile('project/distribution.yaml'),
    /** A publisher: distribution.yaml with `repo: biz` and answers at `commit`. */
    makePublisher({commit = 'v3'} = {}) { project.writeDistribution(); project.writeAnswers({commit}); },

    addExtension: (id, src = `gh:x/${id}`) => project.writeFile(`.copier-answers.ext-${id}.yml`, `_src_path: ${src}\n`),
    writeMcp: servers => project.writeFile('project/mcp.json', {mcpServers: servers}),
    readMcp: () => JSON.parse(project.readFile('project/mcp.json') || '{"mcpServers":{}}').mcpServers,
    writeTeam: botNames => project.writeFile('project/bots/team.yaml', `bots:\n${botNames.map(name => `  - name: ${name}\n`).join('')}`),
    /** The delivered (encrypted) secrets file: `state/dist/secrets.sops.yaml`. */
    writeSecrets: names => project.writeFile('state/dist/secrets.sops.yaml', `${names.map(name => `${name}: ENC[x]\n`).join('')}sops: {}\n`),
    /** `.data/dist/merge-conflicts.json`, read after a `dist:update` that exited 4. */
    writeMergeConflicts: files => project.writeFile('.data/dist/merge-conflicts.json', {files}),
    /** `.data/dist/secrets-pending.json`: secrets the framework could not decrypt. */
    writePendingSecrets: names => project.writeFile('.data/dist/secrets-pending.json', {names}),
    /** `.data/omb/.fyso-restored`: the project has started, so a full `mise run snapshot` is required. */
    markStarted: () => project.writeFile('.data/omb/.fyso-restored', ''),

    /**
     * The saved profile grant (`profile-oauth.json`) that `store.profileAccessToken()` reads and the
     * distribution commands use. `expiresAt` is epoch ms (default: far future); `accessToken` 'profile-token'.
     */
    writeProfileGrant({accessToken = 'profile-token', refreshToken = 'profile-refresh', expiresAt = Date.now() + 8 * 3_600_000, clientId = 'client-1', connectedAt = new Date().toISOString()} = {}) {
      fs.mkdirSync(bizDir, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(bizDir, 'profile-oauth.json'), JSON.stringify({origin: new URL(bizUrl).origin, clientId, accessToken, refreshToken, expiresAt, connectedAt}), {mode: 0o600});
    },
    readProfileGrant() { try { return JSON.parse(fs.readFileSync(path.join(bizDir, 'profile-oauth.json'), 'utf8')); } catch { return null; } },
  };

  if (seed) {
    for (const id of ['biz', 'foo', 'bar']) project.addExtension(id);
    project.writeMcp({mine: {url: 'http://x'}, fromsetup: {url: 'http://y'}});
    project.writeTeam(['Mine', 'Shared']);
    project.writeSecrets(['API_KEY', 'OTHER']);
  }
  if (t) t.after(project.cleanup);
  return project;
}

module.exports = {tempProject, miniYaml};
