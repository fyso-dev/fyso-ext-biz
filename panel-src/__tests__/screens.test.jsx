import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { fakeFetch, route } from './fake-fetch.mjs';
import { translate as t } from './panel-sdk';

const quiet = () => {};
const accessUrl = '/api/panel-access';
const teamsUrl = '/api/ext/biz/teams';
const contextUrl = '/api/ext/biz/context?department=';
const mailUrl = '/api/ext/biz/mail/addresses';
const workUrl = '/api/ext/biz/work';
const teamWorkflow = '/test/dagu/ext-biz-team';
const daguResult = result => ({ outputs: { result: JSON.stringify(result) } });
const team = {
  id: 'team', slug: 'team', name: 'Support agents', description: 'Responds to support tickets',
  version: 2, agents: 1, skills: 0, localVersion: null, department: null,
};
const department = { id: 'support', name: 'Customer Support' };
const context = {
  collectedAt: '2026-05-01T12:00:00.000Z', toolCount: 3, organization: 'Example',
  departments: [department], department: department.id,
  capabilities: {}, warnings: [], truncated: false, objectives: [], requests: [], levers: [],
  kpis: [{
    id: 'wait', name: 'Response time', status: 'saludable', value: 4, target: 5,
    unit: 'min', operator: 'menor', window: null, measuredAt: '2026-05-01T12:00:00.000Z',
  }],
};
const sync = {
  publishSupported: true, proposalsSupported: true,
  departments: [{
    department: 'Platform', localName: null, equipoId: 'team', version: 2, remoteVersion: 2,
    state: 'synced', proposal: null,
  }],
};
const alert = text => expect(screen.getByRole('alert').textContent).toContain(text);
const flush = () => act(async () => {});

// read.ts remembers whether the gateway is available for the lifetime of a page.
beforeEach(() => vi.resetModules());

test('Access loads departments and shows the reauthorization warning', async () => {
  const { Access, useBizAccess } = await import('../screens/Access');

  function Profile() {
    const access = useBizAccess();
    return access && <Access access={access} />;
  }

  const access = {
    admin: false, departments: [{ ...department, role: { id: 'miembro', name: 'Member' }, teams: [] }],
    policy: null, capabilities: [],
  };
  route('GET', accessUrl, access);
  render(<Profile />);
  expect(screen.queryByText(department.name)).toBeNull();
  await flush();
  expect(screen.getByText(department.name)).toBeTruthy();

  cleanup();
  route('GET', accessUrl, { ...access, departments: [], reauthorizeRequired: true });
  render(<Profile />);
  await flush();
  alert(t('access.reauthorize'));
  expect(screen.getByRole('button', { name: t('access.reconnect') })).toBeTruthy();
});

test('Biz loads the overview and shows the connection error when it is unavailable', async () => {
  const { Biz } = await import('../screens/Biz');
  route('GET', accessUrl, undefined, 204);
  route('GET', '/api/ext/biz/profile/status', undefined, 404);
  route('GET', teamsUrl, { connection: { connected: true, method: 'token', url: 'https://biz.example.test' }, teams: [team] });
  route('POST', teamWorkflow, daguResult(sync));
  render(<Biz />);
  expect(screen.getByText(t('biz.connecting'))).toBeTruthy();
  await flush();
  expect(screen.getByRole('heading', { name: team.name })).toBeTruthy();
  expect(screen.getByRole('link', { name: t('biz.open') }).getAttribute('href')).toBe('https://biz.example.test');

  cleanup();
  sessionStorage.clear();
  route('GET', teamsUrl, { error: 'connection_failed' }, 503);
  route('POST', teamWorkflow, daguResult({ error: 'connection_failed' }));
  render(<Biz />);
  await flush();
  alert(t('biz.connectionError'));
});

test('Biz waits for the connection before opening Setup automatically', async () => {
  const { Biz } = await import('../screens/Biz');
  const setupUrl = '/api/ext/biz/profile/setup/status';
  route('GET', accessUrl, { departments: [] });
  route('GET', '/api/ext/biz/profile/status', { connected: true });
  route('GET', setupUrl, { connected: true, notices: [] });
  route('POST', teamWorkflow, daguResult(sync));
  let resolveOverview;
  const overview = new Promise(resolve => { resolveOverview = resolve; });
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url, init) => url === teamsUrl ? overview : fetch(url, init));

  render(<Biz />);
  await flush();
  expect(fakeFetch.mock.calls.some(([url]) => url === setupUrl)).toBe(false);
  resolveOverview(Response.json({ connection: { connected: true }, teams: [team] }));
  await flush();
  expect(screen.getByRole('tab', { name: t('biz.tabTeams') }).getAttribute('aria-selected')).toBe('true');
  expect(fakeFetch.mock.calls.some(([url]) => url === setupUrl)).toBe(false);
});

test.each([
  ['before profile sign-in', false, false, 'access.connectButton'],
  ['after profile sign-in', true, false, 'setup.connect'],
  ['when the profile needs reauthorization', true, true, 'access.reconnect'],
])('Biz shows Setup without an agent grant %s', async (_scenario, connected, reauthorizeRequired, action) => {
  const { Biz } = await import('../screens/Biz');
  route('GET', accessUrl, { departments: [], reauthorizeRequired }, connected ? 200 : 204);
  route('GET', '/api/ext/biz/profile/status', { connected });
  route('GET', '/api/ext/biz/profile/setup/status', { connected: false, notices: [] });
  route('GET', teamsUrl, { connection: { connected: false, login: '/agent/login' } });

  render(<Biz />);
  await flush();
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map(tab => tab.textContent)).toEqual([t('biz.tabSetup')]);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  const button = screen.getByRole('button', { name: t(action) });
  if (action !== 'setup.connect') expect(button.form.getAttribute('action')).toBe('/api/ext/biz/profile/login');
});

test('Business loads a KPI and shows an error when the gateway and workflow fail', async () => {
  const { Business } = await import('../screens/Business');
  const onContext = vi.fn();
  route('GET', contextUrl, context);
  render(<Business onContext={onContext} />);
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  await flush();
  expect(screen.getByText('Response time')).toBeTruthy();
  expect(onContext).toHaveBeenLastCalledWith(context);

  cleanup();
  sessionStorage.clear();
  route('GET', contextUrl, undefined, 503);
  route('POST', '/test/dagu/ext-biz-context', undefined, 503);
  render(<Business onContext={onContext} />);
  await flush();
  alert(t('biz.teamErrors.workflow_not_started'));
});

test('Departments loads sync results and reports a failed workflow', async () => {
  const { Departments } = await import('../screens/Departments');
  const props = { version: 0, onPull: quiet, onPublished: async () => {}, onRestoreName: quiet };
  route('GET', accessUrl, undefined, 204);
  route('POST', teamWorkflow, daguResult(sync));
  const view = render(<Departments {...props} />);
  expect(screen.getByText(t('biz.syncLoading'))).toBeTruthy();
  await flush();
  expect(screen.getByText('Platform')).toBeTruthy();
  expect(screen.getByText(t('biz.syncStates.synced'))).toBeTruthy();
  const request = fakeFetch.mock.calls.find(([url]) => url === teamWorkflow);
  expect(JSON.parse(request[1].body)).toEqual({ FYSO_BIZ_OP: 'team-sync' });

  route('POST', teamWorkflow, daguResult({ error: 'connection_failed' }));
  view.rerender(<Departments {...props} version={1} />);
  await flush();
  alert(t('biz.teamErrors.connection_failed'));
});

test('Departments does not run the check for a read-only member and does not claim Biz is unreachable', async () => {
  const { Departments } = await import('../screens/Departments');
  const props = { version: 0, onPull: quiet, onPublished: async () => {}, onRestoreName: quiet };
  // A member of the Cuidado policy: no `workflow:*:run`; the gateway would answer 403 to the run.
  route('GET', accessUrl, { capabilities: ['app:panel', 'framework:machine:read', 'workflow:ext-biz-team:read'] });
  route('POST', teamWorkflow, daguResult(sync));
  const view = render(<Departments {...props} />);
  await flush();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain(t('biz.syncReadOnly'));
  expect(fakeFetch.mock.calls.some(([url]) => url === teamWorkflow)).toBe(false);
  expect(screen.getByRole('button', { name: t('biz.syncRefresh') }).disabled).toBe(true);

  // Someone who may run it gets the check, once the capabilities are known.
  cleanup();
  route('GET', accessUrl, { capabilities: ['workflow:ext-biz-team:run'] });
  render(<Departments {...props} />);
  await flush();
  expect(screen.getByText('Platform')).toBeTruthy();
  expect(screen.queryByText(t('biz.syncReadOnly'))).toBeNull();
  void view;
});

test('Mail loads the agent address and reports a failed address fetch', async () => {
  const { Mail } = await import('../screens/Mail');
  route('GET', mailUrl, [{ bot: 'agent', address: 'agent@example.test' }]);
  render(<Mail />);
  const toggle = screen.getByRole('switch');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  await flush();
  expect(screen.getByText('agent@example.test')).toBeTruthy();
  expect(toggle.getAttribute('aria-checked')).toBe('true');

  cleanup();
  route('GET', mailUrl, { error: 'unavailable' }, 503);
  render(<Mail />);
  await flush();
  alert(t('biz.mailError'));
});

test('Teams renders loading, a populated card and the list error', async () => {
  const { Teams } = await import('../screens/Teams');
  const reload = async () => {};
  route('GET', accessUrl, undefined, 204);
  route('POST', teamWorkflow, sync);
  const view = render(<Teams loading reload={reload} />);
  expect(screen.getByText(t('biz.teamsLoading'))).toBeTruthy();

  view.rerender(<Teams teams={[team]} loading={false} reload={reload} />);
  await flush();
  expect(screen.getByRole('heading', { name: team.name })).toBeTruthy();
  expect(screen.getByText(team.description)).toBeTruthy();

  view.rerender(<Teams error="connection_failed" loading={false} reload={reload} />);
  alert(t('biz.teamErrors.connection_failed'));
});

test('Work loads available work and reports a failed work fetch', async () => {
  const { Work } = await import('../screens/Work');
  route('GET', contextUrl, context);
  route('GET', workUrl, {
    enabled: true, target: { kind: 'bot', target: 'agent' }, identity: 'Fixture project',
    available: [{ id: 'request', title: 'Review incoming requests' }], entries: [],
  });
  render(<Work />);
  expect(screen.getByText(t('biz.loading'))).toBeTruthy();
  await flush();
  expect(screen.getByRole('option', { name: department.name }).selected).toBe(true);
  expect(screen.getByText('Review incoming requests')).toBeTruthy();

  cleanup();
  route('GET', workUrl, { error: 'unavailable' }, 503);
  render(<Work />);
  await flush();
  alert(t('biz.workError'));
});

test('Teams disables download, update and review for a read-only member', async () => {
  const { Teams } = await import('../screens/Teams');
  route('GET', accessUrl, { capabilities: ['workflow:ext-biz-team:read'] });
  render(<Teams teams={[team, {...team, id: 'update', localVersion: 1}, {...team, id: 'current', localVersion: 2}]} loading={false} reload={quiet} />);
  await flush();
  expect(screen.getByText(t('biz.syncReadOnly'))).toBeTruthy();
  for (const key of ['teamDownload', 'teamUpdateAction', 'teamReview']) {
    const button = screen.getByRole('button', { name: t('biz.' + key) });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(fakeFetch.mock.calls.map(([url]) => url)).toEqual([accessUrl]);
});

test.each([true, false])('Teams prepares and reviews with run grants, with apply grant: %s', async mayApply => {
  const { Teams } = await import('../screens/Teams');
  const capabilities = ['workflow:ext-biz-team:run', 'workflow:fyso-bots-plan:run'];
  if (mayApply) capabilities.push('workflow:fyso-bots-apply:run');
  route('GET', accessUrl, { capabilities });
  route('POST', teamWorkflow, daguResult(sync));
  route('POST', '/test/dagu/fyso-bots-plan', { outputs: { plan: JSON.stringify({ plan: [], created: 1, changed: 0, deleted: 0 }) } });
  route('POST', '/test/dagu/fyso-bots-apply', { outputs: { apply: JSON.stringify({ commit: 'abc', created: 1, changed: 0 }) } });
  render(<Teams teams={[{...team, localVersion: 2}]} loading={false} reload={quiet} />);
  await flush();
  const review = screen.getByRole('button', { name: t('biz.teamReview') });
  expect(review.disabled).toBe(false);
  route('POST', teamWorkflow, daguResult({teamB64: 'abc', bots: [], skills: []}));
  fireEvent.click(review);
  await flush();
  const apply = screen.getByRole('button', { name: t('biz.teamApply') });
  expect(apply.disabled).toBe(!mayApply);
  route('POST', teamWorkflow, daguResult(sync));
  fireEvent.click(apply);
  await flush();
  expect(fakeFetch.mock.calls.some(([url]) => url === '/test/dagu/fyso-bots-apply')).toBe(mayApply);
});

test('Teams reports a refused workflow start separately from a Biz connection failure', async () => {
  const { Teams } = await import('../screens/Teams');
  route('GET', accessUrl, undefined, 204);
  route('POST', teamWorkflow, daguResult(sync));
  render(<Teams teams={[team]} loading={false} reload={quiet} />);
  await flush();
  route('POST', teamWorkflow, undefined, 403);
  fireEvent.click(screen.getByRole('button', { name: t('biz.teamDownload') }));
  await flush();
  expect(screen.getAllByRole('alert').every(node => node.textContent.includes(t('biz.teamErrors.workflow_not_started')))).toBe(true);
  expect(screen.queryByText(t('biz.teamErrors.connection_failed'))).toBeNull();
});

test.each(['http', 'network'])('Departments distinguishes a failed permissions lookup (%s)', async failure => {
  const { Departments } = await import('../screens/Departments');
  route('GET', accessUrl, undefined, 503);
  if (failure === 'network') fakeFetch.mockRejectedValueOnce(Error('network'));
  render(<Departments version={0} onPull={quiet} onPublished={quiet} onRestoreName={quiet} />);
  await flush();
  expect(screen.getByText(t('biz.permissionsUnavailable'))).toBeTruthy();
  expect(screen.queryByText(t('biz.syncReadOnly'))).toBeNull();
  expect(screen.getByRole('button', { name: t('biz.syncRefresh') }).disabled).toBe(true);
  expect(fakeFetch.mock.calls.map(([url]) => url)).toEqual([accessUrl]);
});
