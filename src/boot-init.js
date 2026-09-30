// Hermes Mobile boot init — runs BEFORE the renderer bundle (module scripts
// execute in document order). Installs the Capacitor bridge as
// window.hermesDesktop and exposes the quick-connect helper for first-run.
import { installMobileBridge } from './mobile-bridge.js';

const bridge = installMobileBridge();

globalThis.hermesMobile = {
  version: '0.3.0',
  quickConnect: (input) => bridge.quickConnect(input),
  // On-demand diagnostics (call-only, never automatic): snapshots bridge
  // health + last bridge calls for bug reports. Usage (remote console):
  //   await hermesMobile.debug()
  async debug() {
    const out = { version: '0.2.0', checks: {} };
    try {
      const conn = await bridge.getConnection(null);
      out.checks.connection = { base: conn.baseUrl, token_len: (conn.token || '').length };
    } catch (e) {
      out.checks.connection = { error: String((e && e.message) || e) };
    }
    try {
      const r = await bridge.api({ path: '/api/profiles', timeoutMs: 15000 });
      out.checks.profiles = { ok: true, count: (r && (r.profiles || r).length) ?? '?' };
    } catch (e) {
      out.checks.profiles = { ok: false, error: String((e && e.message) || e) };
    }
    try {
      const conn = await bridge.getConnection(null);
      const ok = await new Promise((resolve) => {
        let done = false;
        const fin = (v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        };
        const t = setTimeout(() => fin('TIMEOUT'), 10000);
        try {
          const ws = new WebSocket(conn.wsUrl);
          ws.addEventListener('open', () => {
            clearTimeout(t);
            try {
              ws.close();
            } catch (_) {}
            fin('OPEN');
          });
          ws.addEventListener('error', () => fin('ERROR'));
          ws.addEventListener('close', (ev) => {
            clearTimeout(t);
            fin('CLOSE ' + ev.code);
          });
        } catch (e) {
          fin('THREW ' + ((e && e.message) || e));
        }
      });
      out.checks.websocket = ok;
    } catch (e) {
      out.checks.websocket = 'THREW ' + ((e && e.message) || e);
    }
    return out;
  }
};

// Deep-link provisioning (also how the Termux connection card onboards):
// opening ?backend=<url>&token=<tok> saves the connection, then reboots
// clean with creds stripped from the URL and history.
const params = new URLSearchParams(location.search);
if (params.get('backend') || params.get('token')) {
  await bridge.quickConnect({
    baseUrl: params.get('backend') || 'http://127.0.0.1:9119',
    token: params.get('token') || undefined
  }).catch(() => ({ ok: false }));
  location.href = location.pathname + location.hash;
}
