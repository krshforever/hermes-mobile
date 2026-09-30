#!/usr/bin/env node
/**
 * Backend smoke test for hermes-mobile (Path A: phone -> remote `hermes serve`).
 *
 *   HERMES_MOBILE_BACKEND=https://100.64.0.1:9119 HERMES_MOBILE_TOKEN=... node smoke-backend.mjs
 *
 * Probes, in order: /api/status (public) -> /api/profiles (session token) ->
 * /api/sessions list -> WS /api/ws?token= handshake. Exit 0 only if all pass.
 * Mirrors desktop's own checks: X-Hermes-Session-Token for REST, ?token= for WS.
 */

const base = (process.env.HERMES_MOBILE_BACKEND || '').replace(/\/+$/, '');
const token = process.env.HERMES_MOBILE_TOKEN || '';

if (!base) {
  console.error('set HERMES_MOBILE_BACKEND (e.g. http://127.0.0.1:9119)');
  process.exit(2);
}

const headers = token ? { 'X-Hermes-Session-Token': token } : {};
let failures = 0;

const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name} — ${e.message}`);
  }
};

await check('GET /api/status', async () => {
  const res = await fetch(`${base}/api/status`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`status ${res.status}: ${text.slice(0, 120)}`);
  if (text.trimStart().startsWith('<')) throw new Error('got HTML, not JSON — wrong port or path prefix');
  const json = JSON.parse(text);
  return `auth_required=${json.auth_required ?? 'n/a'}`;
});

await check('GET /api/profiles (session token)', async () => {
  if (!token) throw new Error('skipped — no HERMES_MOBILE_TOKEN');
  const res = await fetch(`${base}/api/profiles`, { headers });
  if (res.status === 401 || res.status === 403) throw new Error(`${res.status} — token rejected, re-check the dashboard session token`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const json = await res.json();
  const names = (json.profiles || json || []).length ?? '?';
  return `profiles=${names}`;
});

await check('GET /api/profiles/sessions list', async () => {
  if (!token) throw new Error('skipped — no HERMES_MOBILE_TOKEN');
  // Real desktop contract (apps/desktop/src/api/sessions.ts listAllProfileSessions).
  const res = await fetch(
    `${base}/api/profiles/sessions?limit=5&offset=0&min_messages=0&archived=exclude&order=recent&profile=all`,
    { headers }
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  await res.json();
  return 'list parses';
});

await check('WS /api/ws?token= handshake', async () => {
  if (!token) throw new Error('skipped — no HERMES_MOBILE_TOKEN');
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no open within 10s')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('socket error — token rejected or WS blocked by proxy'));
    });
  });
  return 'upgrade accepted';
});

console.log(failures === 0 ? '\nALL GREEN — point the app at this backend.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
