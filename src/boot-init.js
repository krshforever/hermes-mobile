// Hermes Mobile boot init — runs BEFORE the renderer bundle (module scripts
// execute in document order). Installs the Capacitor bridge as
// window.hermesDesktop and exposes the quick-connect helper for first-run.
import { installMobileBridge } from './mobile-bridge.js';

const bridge = installMobileBridge();

globalThis.hermesMobile = {
  version: '0.2.0',
  quickConnect: (input) => bridge.quickConnect(input)
};
