import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CHECKS, TARGET, MonitorError, bounded, readJson, classifyReport,
  probe, markerFor, planIncident, createGitHubApi, reconcile, runMonitor,
} from './monitor.mjs';

const healthy = () => ({ ok: true, checks: CHECKS.map(name => ({ name, state: 'ok' })) });
const json = (data, options) => new Response(JSON.stringify(data), options);
const failure = { healthy: false, code: 'http' };
const success = { healthy: true, code: 'healthy' };
const at = '2026-09-30T12:00:00.000Z';
const run = 'https://github.com/example/monitor/actions/runs/123';
const issue = (mode = 'live', overrides = {}) => ({ number: 1, state: 'open',
  user: { login: 'github-actions[bot]' }, body: `${markerFor(mode)}\nOriginal incident`, ...overrides });
const errorCode = code => error => error instanceof MonitorError && error.code === code;

test('health requires the exact expected contract, independent of order and optional fields', () => {
  assert.deepEqual(classifyReport(healthy()), success);
  const report = healthy();
  report.checks.reverse();
  report.checks[0].status = 401;
  report.checks[0].ms = 4;
  assert.deepEqual(classifyReport(report), success);
});

for (const name of CHECKS) for (const state of ['down', 'paused', 'skipped']) {
  test(`fails safely on ${name}=${state}`, () => {
    const report = healthy();
    report.checks.find(check => check.name === name).state = state;
    assert.deepEqual(classifyReport(report), { healthy: false, code: `check_${name}_${state}` });
  });
}

for (const [label, report] of [
  ['null', null], ['array', []], ['missing ok', { checks: healthy().checks }],
  ['string ok', { ...healthy(), ok: 'true' }], ['missing checks', { ok: true }],
  ['non-array checks', { ok: true, checks: {} }],
  ['missing check', { ok: true, checks: healthy().checks.slice(1) }],
  ['extra check', { ok: true, checks: [...healthy().checks, { name: 'other', state: 'ok' }] }],
  ['duplicate', { ok: true, checks: [healthy().checks[0], ...healthy().checks.slice(0, 3)] }],
  ['unknown name', { ok: true, checks: [{ name: 'secret text', state: 'ok' }, ...healthy().checks.slice(1)] }],
  ['unknown state', { ok: true, checks: [{ name: 'database', state: 'secret text' }, ...healthy().checks.slice(1)] }],
  ['null check', { ok: true, checks: [null, ...healthy().checks.slice(1)] }],
  ['ok false', { ...healthy(), ok: false }],
]) test(`rejects ${label} without echoing untrusted text`, () => {
  assert.deepEqual(classifyReport(report), { healthy: false, code: 'invalid_report' });
});

test('probe uses the fixed public target without credentials or redirects', async () => {
  let calls = 0;
  assert.deepEqual(await probe(async (url, options) => {
    calls++;
    assert.equal(url, TARGET);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return json(healthy());
  }), success);
  assert.equal(calls, 1);
});

for (const status of [301, 302, 307, 308, 401, 500, 503]) {
  test(`HTTP ${status} cannot be overridden by a healthy body`, async () => {
    assert.deepEqual(await probe(async () => json(healthy(), { status })),
      { healthy: false, code: status < 400 ? 'redirect' : 'http' });
  });
}

test('invalid and oversized bodies produce fixed codes only', async () => {
  assert.deepEqual(await probe(async () => new Response('malicious confidential text')),
    { healthy: false, code: 'invalid_json' });
  assert.deepEqual(await probe(async () => new Response('x'.repeat(8193))),
    { healthy: false, code: 'body_limit' });
  await assert.rejects(readJson(new Response(null), 8192), errorCode('invalid_json'));
  await assert.rejects(readJson(new Response(new Uint8Array([0xff])), 8192), errorCode('invalid_json'));
  assert.deepEqual(await readJson(new Response(' '.repeat(8190) + '{}'), 8192), {});
});

test('streamed body limit applies across chunks and cancels on overflow', async () => {
  let canceled = false;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(5000)); controller.enqueue(new Uint8Array(5000));
  }, cancel() { canceled = true; } });
  await assert.rejects(readJson(new Response(stream), 8192), errorCode('body_limit'));
  assert.equal(canceled, true);
});

test('failed body cancellation cannot hide the overflow finding', async () => {
  let released = false;
  await assert.rejects(readJson({ body: { getReader() { return {
    async read() { return { done: false, value: new Uint8Array(8193) }; },
    async cancel() { throw new Error('synthetic cancellation failure'); },
    releaseLock() { released = true; },
  }; } } }, 8192), errorCode('body_limit'));
  assert.equal(released, true);
});

test('network errors and stalled headers are sanitized and bounded', async () => {
  assert.deepEqual(await probe(async () => { throw new Error('secret connection details'); }),
    { healthy: false, code: 'network' });
  let signal;
  assert.deepEqual(await probe((_url, options) => {
    signal = options.signal; return new Promise(() => {});
  }, 10), { healthy: false, code: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('deadline covers complete body consumption, not only headers', async () => {
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); } });
  assert.deepEqual(await probe(async () => new Response(stream), 10),
    { healthy: false, code: 'timeout' });
});

test('bounded operation propagates errors and aborts its signal after completion', async () => {
  let signal;
  assert.equal(await bounded(async observed => { signal = observed; return 7; }), 7);
  assert.equal(signal.aborted, true);
  await assert.rejects(bounded(() => { throw new MonitorError('example'); }), errorCode('example'));
});

test('pure incident transitions separate synthetic and live incidents', () => {
  assert.equal(planIncident(failure, [], 'live', at, run).action, 'create');
  assert.equal(planIncident(success, [], 'live', at, run).action, 'none');
  assert.equal(planIncident(failure, [issue()], 'live', at, run).action, 'ongoing');
  const recovery = planIncident(success, [issue()], 'live', at, run);
  assert.equal(recovery.action, 'recover');
  assert.match(recovery.body, /Original incident/);
  assert.match(recovery.body, /Recovered observation: 2026-09-30/);
  assert.equal(planIncident(success, [issue()], 'synthetic-recovery', at, run).action, 'none');
  assert.equal(planIncident(success, [issue('synthetic-failure')], 'live', at, run).action, 'none');
  const synthetic = planIncident(failure, [issue()], 'synthetic-failure', at, run);
  assert.match(synthetic.title, /^SELF-TEST:/);
  assert.match(synthetic.body, /not a product outage/);
  assert.deepEqual(synthetic.labels, ['levelclose-monitor', 'self-test']);
});

test('unrelated, human-authored, closed and PR issues are never reconciled', () => {
  const unrelated = [issue('live', { body: 'Other text' }), issue('live', { user: { login: 'human' } }),
    issue('live', { state: 'closed' }), issue('live', { pull_request: {} }), issue('live', { body: null })];
  assert.equal(planIncident(failure, unrelated, 'live', at, run).action, 'create');
  assert.throws(() => planIncident(failure, [issue(), issue()], 'live', at, run), errorCode('duplicate_incidents'));
  assert.throws(() => planIncident(failure, [issue('live', { number: -1 })], 'live', at, run), errorCode('invalid_issue'));
  assert.throws(() => markerFor('arbitrary input'), errorCode('invalid_mode'));
});

function memoryApi(initial = []) {
  const issues = [...initial];
  const writes = [];
  const api = { async request(method, path, payload) {
    if (method === 'GET') return { data: issues.filter(item => item.state === 'open'), next: false };
    writes.push({ method, path, payload });
    if (method === 'POST') {
      const created = issue('live', { number: issues.length + 1, body: payload.body });
      issues.push(created); return { data: created };
    }
    const existing = issues.find(item => path === `/issues/${item.number}`);
    Object.assign(existing, payload); return { data: existing };
  } };
  return { api, issues, writes };
}

test('failure/failure/recovery/recovery writes exactly one incident and one closure', async () => {
  const { api, writes, issues } = memoryApi();
  assert.equal((await reconcile(api, failure, 'live', at, run)).action, 'create');
  assert.equal((await reconcile(api, failure, 'live', at, run)).action, 'ongoing');
  assert.equal((await reconcile(api, success, 'live', at, run)).action, 'recover');
  assert.equal((await reconcile(api, success, 'live', at, run)).action, 'none');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].state, 'closed');
  assert.deepEqual(writes.map(write => write.method), ['POST', 'PATCH']);
});

test('complete paginated read finds later incident before writing', async () => {
  const calls = [];
  const api = { async request(method, path) {
    calls.push(method);
    return path.endsWith('page=1') ? { data: [], next: true } : { data: [issue()], next: false };
  } };
  assert.equal((await reconcile(api, failure, 'live', at, run)).action, 'ongoing');
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('incomplete or failed scans never mutate incident state', async () => {
  const methods = [];
  await assert.rejects(reconcile({ async request(method) {
    methods.push(method); return { data: [], next: true };
  } }, success, 'live', at, run), errorCode('incomplete_issue_scan'));
  assert.deepEqual(methods, ['GET', 'GET', 'GET', 'GET', 'GET']);
  await assert.rejects(reconcile({ async request() { throw new MonitorError('api_http'); } },
    failure, 'live', at, run), errorCode('api_http'));
  for (const result of [{ data: {}, next: false }, { data: [null], next: false },
    { data: [], next: undefined }, { data: Array(101).fill(issue()), next: false }]) {
    await assert.rejects(reconcile({ async request() { return result; } }, failure, 'live', at, run),
      errorCode('invalid_issue_page'));
  }
});

test('failed and ambiguous mutations are not retried', async () => {
  for (const [observation, initial, response, code] of [
    [failure, [], {}, 'unknown_create_outcome'], [success, [issue()], {}, 'unknown_recovery_outcome'],
  ]) {
    let writes = 0;
    const api = { async request(method) {
      if (method === 'GET') return { data: initial, next: false };
      writes++; return { data: response };
    } };
    await assert.rejects(reconcile(api, observation, 'live', at, run), errorCode(code));
    assert.equal(writes, 1);
  }
  let calls = 0;
  await assert.rejects(reconcile({ async request(method) {
    if (method === 'GET') return { data: [], next: false };
    calls++; throw new Error('unknown write outcome');
  } }, failure, 'live', at, run), /unknown write outcome/);
  assert.equal(calls, 1);
});

test('API adapter uses only its repository, bounded JSON and ephemeral token', async () => {
  const api = createGitHubApi({ repository: 'example/monitor', token: 'synthetic-token',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/example/monitor/issues');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      assert.equal(options.body, JSON.stringify({ title: 'test' }));
      return json({ number: 1 }, { headers: { link: '<https://api.github.com/example>; rel="next"' } });
    } });
  assert.deepEqual(await api.request('POST', '/issues', { title: 'test' }), { data: { number: 1 }, next: true });
  assert.throws(() => createGitHubApi({ repository: 'https://evil.example', token: 'test' }), errorCode('invalid_configuration'));
  assert.throws(() => createGitHubApi({ repository: 'example/monitor' }), errorCode('invalid_configuration'));
  assert.throws(() => createGitHubApi({ token: 'synthetic-token' }), errorCode('invalid_configuration'));
});

test('API status, malformed body, oversized body, timeout and error are sanitized', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response('secret', { status: 403 }), 'api_http'],
    [async () => new Response('secret'), 'api_invalid_json'],
    [async () => new Response('x'.repeat(256 * 1024 + 1)), 'api_body_limit'],
    [async () => json([], { headers: { link: 'malformed secret pagination text' } }), 'api_pagination'],
    [async () => { throw new Error('token and private header details'); }, 'api_network'],
    [() => new Promise(() => {}), 'api_timeout'],
  ]) {
    const api = createGitHubApi({ repository: 'example/monitor', token: 'synthetic-token', fetchImpl, timeoutMs: 10 });
    await assert.rejects(api.request('GET', '/issues'), errorCode(code));
  }
});

test('API pagination recognizes complete standard Link relations without following URLs', async () => {
  const api = createGitHubApi({ repository: 'example/monitor', token: 'synthetic-token',
    fetchImpl: async () => json([], { headers: { link:
      '<https://api.github.com/repos/example/monitor/issues?page=1>; rel="prev", <https://api.github.com/repos/example/monitor/issues?page=4>; rel="last"' } }) });
  assert.equal((await api.request('GET', '/issues')).next, false);
});

test('synthetic run sequence touches only the API and preserves live incident', async () => {
  const memory = memoryApi([issue()]);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.ok(url.startsWith('https://api.github.com/repos/example/monitor/'));
    const path = new URL(url).pathname.replace('/repos/example/monitor', '') + new URL(url).search;
    const result = await memory.api.request(options.method, path, options.body ? JSON.parse(options.body) : undefined);
    return json(result.data);
  };
  const env = { GITHUB_REPOSITORY: 'example/monitor', GITHUB_TOKEN: 'synthetic-token', GITHUB_RUN_ID: '123' };
  for (const [mode, action] of [['synthetic-failure', 'create'], ['synthetic-failure', 'ongoing'],
    ['synthetic-recovery', 'recover'], ['synthetic-recovery', 'none']]) {
    assert.equal((await runMonitor({ ...env, MONITOR_MODE: mode }, fetchImpl)).action, action);
  }
  assert.equal(memory.issues[0].state, 'open');
  assert.equal(memory.writes.length, 2);
  assert.equal(calls, 6);
  await assert.rejects(runMonitor({ ...env, MONITOR_MODE: 'unknown' }, fetchImpl), errorCode('invalid_mode'));
  await assert.rejects(runMonitor({ ...env, GITHUB_RUN_ID: 'invalid' }, fetchImpl), errorCode('invalid_configuration'));
  await assert.rejects(runMonitor({ GITHUB_REPOSITORY: env.GITHUB_REPOSITORY, GITHUB_TOKEN: env.GITHUB_TOKEN }, fetchImpl),
    errorCode('invalid_configuration'));
});

test('live run never puts repository credentials into the public probe', async () => {
  const env = { GITHUB_REPOSITORY: 'example/monitor', GITHUB_TOKEN: 'synthetic-token', GITHUB_RUN_ID: '123' };
  const result = await runMonitor(env, async (url, options) => {
    if (url === TARGET) { assert.equal(options.headers, undefined); return json(healthy()); }
    return json([]);
  });
  assert.deepEqual(result, { mode: 'live', ...success, action: 'none' });
});

test('CLI emits a sanitized failure and nonzero exit without touching the network', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./monitor.mjs', import.meta.url))], {
    env: { ...process.env, MONITOR_MODE: 'invalid-mode-secret-text' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), JSON.stringify({ code: 'invalid_mode' }));
});

test('CLI healthy execution logs one sanitized result with all fetches injected', () => {
  const path = fileURLToPath(new URL('./monitor.mjs', import.meta.url));
  const script = `process.argv[1] = ${JSON.stringify(path)};
    globalThis.fetch = async url => new Response(JSON.stringify(url === ${JSON.stringify(TARGET)}
      ? ${JSON.stringify(healthy())} : []));
    await import(${JSON.stringify(new URL('./monitor.mjs', import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MONITOR_MODE: 'live', GITHUB_REPOSITORY: 'example/monitor',
      GITHUB_TOKEN: 'synthetic-token', GITHUB_RUN_ID: '123' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { mode: 'live', ...success, action: 'none' });
});

test('CLI unexpected execution error does not leak exception details', () => {
  const path = fileURLToPath(new URL('./monitor.mjs', import.meta.url));
  const script = `process.argv[1] = ${JSON.stringify(path)};
    globalThis.Date = class { constructor() { throw new Error('secret unexpected details'); } };
    globalThis.fetch = () => { throw new Error('network must not be called'); };
    await import(${JSON.stringify(new URL('./monitor.mjs', import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MONITOR_MODE: 'synthetic-failure', GITHUB_REPOSITORY: 'example/monitor',
      GITHUB_TOKEN: 'synthetic-token', GITHUB_RUN_ID: '123' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), JSON.stringify({ code: 'monitor_failed' }));
});
