import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import managedSetup from '../../extensions/biz/managed-setup.cjs';
import { Setup } from '../screens/Setup';
import { fakeFetch, route } from './fake-fetch.mjs';
import { translate as t } from './panel-sdk';
import { setupErrors } from './setup-codes.mjs';

const path = '/api/ext/biz/profile/setup';
const at = '2026-05-01T12:00:00.000Z';
const access = { admin: true, departments: [], policy: null };
const offer = version => ({ version, etag: 'fixture', publishedAt: at, size: 256, sha256: 'a'.repeat(64) });
const status = (overrides = {}) => ({
  connected: true, grant: true, frozen: false, paused: null, publishPaused: null,
  version: 'v2', shownVersion: 'v2', selfPublished: null, noAccess: false,
  appliedAt: at, notices: [], pendingSecrets: 0, secretsPending: [],
  bizVersion: 'v2', admin: true, offered: offer('v2'), remoteFrozen: false, ...overrides,
});
const checks = { gitleaks: 'ok', machine_paths: 'ok' };
const preview = (version = 'v3', file = 'project/team.yaml') => ({
  transport: 'biz', base: 'v2', version, changed: true,
  files: { added: [], modified: [file], removed: [] }, files_count: 1,
  bots: { added: [], modified: [], removed: [] }, extensions: { added: [], removed: [] },
  mcp_servers: { added: [], removed: [] }, secrets: [],
  recipients: { count: 1, changed: false }, framework: null, checks,
  digest: (version === 'v3' ? 'a' : 'b').repeat(64),
});

const serveStatus = payload => route('GET', `${path}/status`, payload);
const post = (op, payload, code) => route('POST', `${path}/${op}`, payload, code);
const button = name => screen.getByRole('button', { name });
const click = async name => {
  await act(async () => { fireEvent.click(button(name)); });
};
const mount = async (bizAccess = access) => {
  await act(async () => { render(<Setup access={bizAccess} />); });
};
const assertNoCodes = () => {
  for (const code of setupErrors) {
    expect(document.body.textContent).not.toContain(code);
  }
  expect(document.body.textContent).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i);
};
const postBodies = op => fakeFetch.mock.calls
  .filter(([url, init]) => url === `${path}/${op}` && init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body));

test('shows the connected setup', async () => {
  serveStatus(status({
    notices: [{ at, kind: 'failed', text: 'Sync failed (dist_failed); the next run tries again' }],
  }));
  await mount();
  expect(screen.getByText('Conectado. Setup v2 aplicado.')).toBeTruthy();
  expect(button(t('setup.publish'))).toBeTruthy();
  assertNoCodes();
});

test.each([
  ['reauthorize_required', '401', 'tu conexión con Fyso Biz venció'],
  ['not_connected', 'not_connected', 'Fyso Biz no está conectado'],
  ['biz_unreachable', '503', 'no se pudo consultar Fyso Biz'],
  ['unexpected_empty_response', undefined, 'Fyso Biz respondió algo inesperado'],
])('regression: a pause always offers a way out (%s)', async (reason, detail, explanation) => {
  const grant = reason !== 'not_connected';
  serveStatus(status({
    connected: grant, grant, bizVersion: null, admin: false, offered: null,
    paused: { reason, at, ...(detail ? { detail } : {}) },
    notices: [{ at, kind: 'paused', text: `Sync paused: ${reason}. Nothing was changed.` }],
  }));
  await mount();
  expect(screen.getByText(`Sincronización en pausa: ${explanation}. No se cambió nada.`)).toBeTruthy();
  if (reason !== 'reauthorize_required') {
    expect(screen.getByText(`La sincronización está en pausa: ${explanation}. No se cambió nada.`)).toBeTruthy();
  }

  const submit = vi.fn(event => event.preventDefault());
  const reauthorize = button('Volver a autorizar');
  const form = reauthorize.form;
  form.addEventListener('submit', submit);
  fireEvent.click(reauthorize);
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0][0].submitter).toBe(reauthorize);
  expect(form.getAttribute('action')).toBe('/api/ext/biz/profile/login');
  expect(form.method).toBe('post');
  expect(form.target).toBe('_top');
  assertNoCodes();
});

test.each([false, true])('shows revoked access on a frozen, paused project (access reauthorization: %s)', async reauthorizeRequired => {
  serveStatus(status({
    frozen: true, remoteFrozen: true, bizVersion: null, offered: null, admin: false,
    paused: { reason: 'biz_unreachable', at },
    notices: [{ at, kind: 'frozen', text: 'Access revoked: read-only, 1 delivered secret(s) removed' }],
  }));
  await mount({ ...access, reauthorizeRequired });
  expect(screen.getByRole('alert').textContent).toContain(t('setup.frozen'));
  expect(screen.getByText('La sincronización está en pausa: no se pudo consultar Fyso Biz. No se cambió nada.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: t('setup.reauthorizeButton') })).toBeNull();
  expect(screen.queryByRole('button', { name: t('access.reconnect') })).toBeNull();
  assertNoCodes();
});

test('keeps the reauthorization action for an unfrozen project with an expired access grant', async () => {
  serveStatus(status());
  await mount({ ...access, reauthorizeRequired: true });
  expect(button(t('access.reconnect'))).toBeTruthy();
});

test('shows an unknown pause without suggesting reauthorization', async () => {
  serveStatus(status({ paused: { reason: 'future_pause', at } }));
  await mount();
  expect(screen.getByText('La sincronización está en pausa: motivo desconocido. No se cambió nada.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: t('setup.reauthorizeButton') })).toBeNull();
  assertNoCodes();
});

test('keeps the redacted multiline snapshot diagnostic in a sync failure notice', async () => {
  const diagnostic = 'Command failed: mise run snapshot\nmise ERROR Operation not permitted (os error 1) at path "<tmp>"\nmise ERROR Version: 2026.11.7';
  serveStatus(status({
    notices: [{ at, kind: 'failed', text: `Sync failed (${diagnostic}\n); the next run tries again` }],
  }));
  await mount();
  await click(t('setup.showMore'));
  const notice = screen.getByRole('listitem');
  expect(notice.textContent).toContain(`Falló la sincronización. (${diagnostic}) Se volverá a intentar en la próxima sincronización.`);
  assertNoCodes();
});

test.each(setupErrors)('localizes %s in a publish error and stored notice', async code => {
  serveStatus(status({
    notices: [{ at, kind: 'publish_failed', text: `Could not publish: ${code}` }],
  }));
  post('publish-preview', { error: 'publish_failed', detail: code }, 502);
  await mount();
  await click(t('setup.publish'));
  const translated = `${t('setup.errors.publish_failed')} (${t(`setup.errors.${code}`)})`;
  expect(within(screen.getByRole('alert')).getByText(translated)).toBeTruthy();
  expect(within(screen.getByRole('listitem')).getByText(translated)).toBeTruthy();
  assertNoCodes();
});

test('shows no access when a signed-in person has never received setup', async () => {
  serveStatus(status({
    connected: false, version: null, shownVersion: null, appliedAt: null,
    bizVersion: null, offered: null, admin: false, noAccess: true, remoteFrozen: true,
  }));
  await mount();
  expect(screen.getByText(t('setup.noAccess'))).toBeTruthy();
  expect(screen.queryByRole('button', { name: t('setup.connect') })).toBeNull();
  assertNoCodes();
});

test('offers sign-in when the Setup status request has no profile session', async () => {
  route('GET', `${path}/status`, undefined, 403);
  await mount();
  expect(button(t('access.connectButton'))).toBeTruthy();
  assertNoCodes();
});

test('shows a failed publish check and blocks confirmation', async () => {
  serveStatus(status());
  const diagnostic = 'machine-specific paths in: project/team.yaml';
  post('publish-preview', {
    blocked: true, version: null, changed: false, digest: 'c'.repeat(64), error: '',
    checks: { gitleaks: 'ok', machine_paths: 'failed', error: diagnostic },
  });
  await mount();
  await click(t('setup.publish'));
  const panel = screen.getByRole('group', { name: t('setup.pub.title') });
  expect(within(panel).getByRole('alert').textContent).toContain(diagnostic);
  expect(within(panel).getByText('Búsqueda de secretos: Correcta')).toBeTruthy();
  expect(within(panel).getByText('Rutas específicas de la máquina: Falló')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: t('setup.pub.confirm') })).toBeNull();
  expect(postBodies('publish')).toEqual([]);
  assertNoCodes();
});

test('refreshes a 409 stale preview and waits for another confirmation', async () => {
  serveStatus(status());
  const first = preview();
  post('publish-preview', first);
  await mount();
  await click(t('setup.publish'));
  expect(screen.getByText('De v2 a v3')).toBeTruthy();
  assertNoCodes();

  const second = preview('v4', 'project/revised.yaml');
  post('publish-preview', second);
  post('publish', { error: 'preview_stale' }, 409);
  await click(t('setup.pub.confirm'));
  expect(screen.getByRole('alert').textContent).toContain(t('setup.errors.preview_stale'));
  expect(screen.getByText('De v2 a v4')).toBeTruthy();
  expect(screen.queryByText('De v2 a v3')).toBeNull();
  expect(postBodies('publish-preview')).toEqual([{}, {}]);
  expect(postBodies('publish')).toEqual([{ version: first.version, digest: first.digest }]);
  assertNoCodes();

  serveStatus(status({ version: 'v4', selfPublished: 'v4', shownVersion: 'v4', bizVersion: 'v4', offered: offer('v4') }));
  post('publish', { output: 'published v4 (1 files) to Biz', version: 'v4' });
  await click(t('setup.pub.confirm'));
  expect(postBodies('publish').at(-1)).toEqual({ version: second.version, digest: second.digest });
  expect(screen.getByText('Setup v4 publicado.')).toBeTruthy();
  assertNoCodes();
});

test('offers a merge for a stale base and submits the selected conflict resolutions', async () => {
  serveStatus(status({ bizVersion: 'v3', offered: offer('v3') }));
  post('publish-preview', { error: 'stale_base' }, 409);
  await mount();
  await click(t('setup.publish'));
  expect(screen.getByRole('alert').textContent).toContain(t('setup.errors.stale_base'));
  assertNoCodes();

  const files = ['project/team.yaml', 'project/service.yaml'];
  serveStatus(status({ bizVersion: 'v3', offered: offer('v3'), publishPaused: { files, at } }));
  post('merge', { error: 'merge_conflict', files }, 409);
  await click(t('setup.mergeAndPublish'));
  expect(screen.getByRole('alert').textContent).toContain(t('setup.errors.merge_conflict'));
  expect(screen.getByText(t('setup.publishPaused', { files: files.join(', ') }))).toBeTruthy();
  const conflicts = screen.getByRole('group', { name: t('setup.conflicts') });
  expect(within(conflicts).getByText(files[0])).toBeTruthy();
  expect(within(conflicts).getByText(files[1])).toBeTruthy();
  const resolve = button(t('setup.resolveMerge'));
  expect(resolve.disabled).toBe(true);
  fireEvent.click(within(conflicts).getAllByRole('radio', { name: t('setup.keepMine') })[0]);
  expect(resolve.disabled).toBe(true);
  fireEvent.click(within(conflicts).getAllByRole('radio', { name: t('setup.takePublished') })[1]);
  expect(resolve.disabled).toBe(false);
  assertNoCodes();

  serveStatus(status({ version: 'v4', selfPublished: 'v4', shownVersion: 'v4', bizVersion: 'v4', offered: offer('v4') }));
  post('merge', { output: 'published v4 (2 files) to Biz', version: 'v4' });
  await click(t('setup.resolveMerge'));
  expect(postBodies('merge')).toEqual([{}, { ours: [files[0]], theirs: [files[1]] }]);
  expect(screen.queryByRole('group', { name: t('setup.conflicts') })).toBeNull();
  expect(screen.queryByText(/La publicación automática está en pausa/)).toBeNull();
  assertNoCodes();
});

test('regression: repeated identical notices are collapsed and the full history can be opened', async () => {
  const recent = 'Sync paused: biz_unreachable. Nothing was changed.';
  const long = 'Access restored: the setup is applied again, secrets included when the published version was encrypted for your key (otherwise they arrive with the next version).';
  const raw = [
    { kind: 'connected', text: 'Applied setup v2' },
    { kind: 'applied', text: 'Setup v3 applied; removed 1 item(s) not allowed by policy' },
    { kind: 'applied', text: 'Setup v4 applied' },
    { kind: 'published', text: 'Published setup v5 (1 files)' },
    { kind: 'unfrozen', text: long },
    ...Array.from({ length: 3 }, () => ({ kind: 'paused', text: recent })),
  ].map((entry, i) => ({ ...entry, at: new Date(Date.parse(at) + i * 60000).toISOString() }));
  serveStatus(status({ notices: managedSetup.collapseNotices(raw) }));
  await mount();

  const repeated = screen.getByText('Sincronización en pausa: no se pudo consultar Fyso Biz. No se cambió nada.').closest('li');
  expect(within(repeated).getByTitle('Se repitió 3 veces').textContent).toBe('×3');
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  expect(screen.queryByText('Applied setup v2')).toBeNull();

  const longText = screen.getByText(long);
  expect(longText.classList.contains('biz-event-clamp')).toBe(true);
  expect(button('Ver más').getAttribute('aria-expanded')).toBe('false');
  await click('Ver más');
  expect(button('Ver menos').getAttribute('aria-expanded')).toBe('true');
  expect(longText.classList.contains('biz-event-clamp')).toBe(false);
  await click('Ver menos');
  expect(longText.classList.contains('biz-event-clamp')).toBe(true);

  await click('Ver todos (6)');
  expect(button('Ver menos avisos').getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByText('Applied setup v2')).toBeTruthy();
  await click('Ver menos avisos');
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  assertNoCodes();
});

test('regression: the shown version follows Biz after a publish', async () => {
  serveStatus(status({ selfPublished: 'v2' }));
  const next = preview('v4');
  post('publish-preview', next);
  await mount();
  expect(screen.getByText('Conectado. Setup v2 publicado por este proyecto.')).toBeTruthy();
  await click(t('setup.publish'));

  // Our publish completed, then another publisher advanced Biz before the status reload.
  serveStatus(status({ version: 'v4', selfPublished: 'v4', shownVersion: 'v4', bizVersion: 'v5', offered: offer('v5') }));
  post('publish', { output: 'published v4 (1 files) to Biz', version: 'v4' });
  await click(t('setup.pub.confirm'));
  expect(postBodies('publish')).toEqual([{ version: next.version, digest: next.digest }]);
  expect(screen.getByText('Setup v4 publicado.')).toBeTruthy();
  expect(screen.getByText('Conectado. Setup v5 aplicado.')).toBeTruthy();
  expect(screen.queryByText(/Conectado\. Setup v[124]\b/)).toBeNull();
  assertNoCodes();
});

test('regression: the shown version follows Biz after a publish from outside the panel', async () => {
  serveStatus(status({ bizVersion: 'v3', offered: offer('v3') }));
  await mount();
  expect(screen.getByText('Conectado. Setup v3 aplicado.')).toBeTruthy();
  expect(screen.queryByText('Conectado. Setup v2 aplicado.')).toBeNull();
  assertNoCodes();
});
