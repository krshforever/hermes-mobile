// Hermes Mobile boot init — runs BEFORE the renderer bundle (module scripts
// execute in document order). Installs the Capacitor bridge as
// window.hermesDesktop and exposes the quick-connect helper for first-run.
import { installMobileBridge } from './mobile-bridge.js';

const bridge = installMobileBridge();

globalThis.hermesMobile = {
  version: '0.2.0',
  quickConnect: (input) => bridge.quickConnect(input)
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
