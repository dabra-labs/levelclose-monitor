import { pathToFileURL } from 'node:url';

export const TARGET = 'https://levelclose.com/api/health';
// Reviewed against LevelClose src/lib/health.ts CheckName on 2026-09-30.
export const CHECKS = Object.freeze(['database', 'signin', 'identity_api', 'auth_project']);
const STATES = new Set(['ok', 'down', 'paused', 'skipped']);
const LABEL = 'levelclose-monitor';
const MODES = new Set(['live', 'synthetic-failure', 'synthetic-recovery']);

export class MonitorError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function bounded(operation, timeoutMs = 10_000) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MonitorError('timeout'));
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function readJson(response, maxBytes) {
  if (!response.body) throw new MonitorError('invalid_json');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new MonitorError('body_limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new MonitorError('invalid_json'); }
}

export function classifyReport(report) {
  const invalid = { healthy: false, code: 'invalid_report' };
  if (!report || typeof report !== 'object' || Array.isArray(report)
      || typeof report.ok !== 'boolean' || !Array.isArray(report.checks)
      || report.checks.length !== CHECKS.length) return invalid;
  const seen = new Map();
  for (const check of report.checks) {
    if (!check || !CHECKS.includes(check.name) || !STATES.has(check.state)
        || seen.has(check.name)) return invalid;
    seen.set(check.name, check.state);
  }
  const failing = CHECKS.find(name => seen.get(name) !== 'ok');
  if (failing) return { healthy: false, code: `check_${failing}_${seen.get(failing)}` };
  return report.ok ? { healthy: true, code: 'healthy' } : invalid;
}

export async function probe(fetchImpl = fetch, timeoutMs = 10_000) {
  try {
    return await bounded(async signal => {
      const response = await fetchImpl(TARGET, { redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400) return { healthy: false, code: 'redirect' };
      if (response.status !== 200) return { healthy: false, code: 'http' };
      return classifyReport(await readJson(response, 8 * 1024));
    }, timeoutMs);
  } catch (error) {
    const code = error instanceof MonitorError ? error.code : 'network';
    return { healthy: false, code };
  }
}

export function markerFor(mode) {
  if (!MODES.has(mode)) throw new MonitorError('invalid_mode');
  return `<!-- levelclose-monitor:${mode === 'live' ? 'live' : 'self-test'}:v1 -->`;
}

export function planIncident(observation, issues, mode, observedAt, runUrl) {
  const marker = markerFor(mode);
  const matching = issues.filter(issue => !issue.pull_request
    && issue.user?.login === 'github-actions[bot]' && issue.state === 'open'
    && typeof issue.body === 'string' && issue.body.startsWith(`${marker}\n`));
  if (matching.length > 1) throw new MonitorError('duplicate_incidents');
  const incident = matching[0];
  if (incident && (!Number.isSafeInteger(incident.number) || incident.number < 1)) {
    throw new MonitorError('invalid_issue');
  }
  if (observation.healthy) {
    return incident ? { action: 'recover', number: incident.number, body:
      `${incident.body}\n\nRecovered observation: ${observedAt}\nRun: ${runUrl}` } : { action: 'none' };
  }
  if (incident) return { action: 'ongoing', number: incident.number };
  const synthetic = mode !== 'live';
  return { action: 'create', title: synthetic ? 'SELF-TEST: synthetic LevelClose health incident' : 'LevelClose health incident',
    labels: synthetic ? [LABEL, 'self-test'] : [LABEL], body:
      `${marker}\n${synthetic ? 'Synthetic notification test. This is not a product outage.' : 'The public health probe observed a failure.'}\n\nCode: ${observation.code}\nFirst observed: ${observedAt}\nRun: ${runUrl}\n\nOwner delivery is not proven by this issue. See the monitor README.` };
}

export function createGitHubApi({ repository, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) {
    throw new MonitorError('invalid_configuration');
  }
  return {
    async request(method, path, payload) {
      try {
        return await bounded(async signal => {
          const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
            method, signal, redirect: 'error', headers: {
              Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
              'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
            }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          });
          if (!response.ok) throw new MonitorError('api_http');
          const link = response.headers.get('link');
          const relations = link === null ? [] : link.split(',').map(part => {
            const relation = part.trim().match(/^<https:\/\/api\.github\.com\/[^>]+>;\s*rel="(next|prev|first|last)"$/);
            if (!relation) throw new MonitorError('api_pagination');
            return relation[1];
          });
          return { data: await readJson(response, 256 * 1024), next: relations.includes('next') };
        }, timeoutMs);
      } catch (error) {
        throw new MonitorError(error instanceof MonitorError ? `api_${error.code.replace(/^api_/, '')}` : 'api_network');
      }
    },
  };
}

export async function reconcile(api, observation, mode, observedAt, runUrl) {
  const issues = [];
  for (let page = 1; ; page++) {
    if (page > 5) throw new MonitorError('incomplete_issue_scan');
    const result = await api.request('GET', `/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`);
    if (!Array.isArray(result.data) || result.data.length > 100 || typeof result.next !== 'boolean'
        || result.data.some(issue => !issue || typeof issue !== 'object')) throw new MonitorError('invalid_issue_page');
    issues.push(...result.data);
    if (result.next) {
      continue;
    }
    const plan = planIncident(observation, issues, mode, observedAt, runUrl);
    if (plan.action === 'create') {
      const created = await api.request('POST', '/issues', { title: plan.title, body: plan.body, labels: plan.labels });
      if (!Number.isSafeInteger(created.data?.number) || created.data.number < 1) throw new MonitorError('unknown_create_outcome');
      return { action: 'create', number: created.data.number };
    }
    if (plan.action === 'recover') {
      const recovered = await api.request('PATCH', `/issues/${plan.number}`, { body: plan.body, state: 'closed' });
      if (recovered.data?.number !== plan.number || recovered.data?.state !== 'closed') throw new MonitorError('unknown_recovery_outcome');
    }
    return { action: plan.action, ...(plan.number === undefined ? {} : { number: plan.number }) };
  }
}

export async function runMonitor(env = process.env, fetchImpl = fetch) {
  const mode = env.MONITOR_MODE ?? 'live';
  markerFor(mode);
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')) throw new MonitorError('invalid_configuration');
  const api = createGitHubApi({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, fetchImpl });
  const observation = mode === 'live' ? await probe(fetchImpl)
    : { healthy: mode === 'synthetic-recovery', code: mode === 'synthetic-recovery' ? 'healthy' : 'synthetic_failure' };
  const runUrl = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const incident = await reconcile(api, observation, mode, new Date().toISOString(), runUrl);
  return { mode, ...observation, ...incident };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runMonitor())); }
  catch (error) {
    console.error(JSON.stringify({ code: error instanceof MonitorError ? error.code : 'monitor_failed' }));
    process.exitCode = 1;
  }
}
