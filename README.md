# Hermes Mobile

Same Hermes Desktop, in Android format. No new protocol, no reinvented
backend: the desktop React renderer in a Capacitor WebView, talking to a
local `hermes serve` gateway on `127.0.0.1` — spare-part architecture,
exactly how Electron hosts it.

- `src/mobile-bridge.ts` — `window.hermesDesktop` replacement (thin-client).
  REST via `X-Hermes-Session-Token`, WS via `/api/ws?token=`, connection
  registry, Bot Mode roster/routes. Contract-checked against
  `NousResearch/hermes-agent` (`apps/desktop/src/global.d.ts`,
  `src/api/client.ts`, `electron/api-transport.ts`, `electron/connection-config.ts`).
- `smoke-backend.mjs` — backend probe. Needs a running gateway:
  `HERMES_MOBILE_BACKEND=http://127.0.0.1:9119 HERMES_MOBILE_TOKEN=... node smoke-backend.mjs`
- Local gateway recipe (what the APK's spawner does): mint token →
  `HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve --host 127.0.0.1 --port 0`
  → parse `HERMES_BACKEND_READY port=N` from stdout → talk.
- `.github/workflows/android.yml` — CI builds the APK (debug): typecheck,
  upstream renderer build, `cap sync`, `assembleDebug`.

Status: Phase 1+2 done and verified on-device (`tsc` clean, smoke ALL GREEN
against APT-packaged `hermes serve` on Termux). Phase 3 (store-ready APK,
native spawner module) builds in CI here.

Upstream: https://github.com/NousResearch/hermes-agent (MIT, attributed in LICENSE).
