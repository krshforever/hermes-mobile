/**
 * Mobile bridge — a Capacitor-compatible replacement for Electron's
 * `window.hermesDesktop` preload surface, scoped to what the renderer
 * needs in thin-client mode (phone talks to a remote `hermes serve`).
 *
 * Source of truth for the full surface:
 *   hermes-agent/apps/desktop/src/global.d.ts
 * Source of truth for request routing semantics:
 *   hermes-agent/apps/desktop/src/api/client.ts (hermesApi, *_scoped helpers)
 *   hermes-agent/apps/desktop/electron/api-transport.ts (REST dispatch)
 *   hermes-agent/apps/desktop/electron/connection-config.ts (token model:
 *     REST X-Hermes-Session-Token, WS ?token=, spawner mints via
 *     HERMES_DASHBOARD_SESSION_TOKEN)
 */

// ── Types (subset of desktop's global.d.ts; same names, mobile scope) ────────

export interface HermesApiRequest {
  path: string;
  method?: string;
  body?: unknown;
  // Single-file multipart upload (FastAPI UploadFile endpoints). Mutually
  // exclusive with `body`. Token-mode backends only.
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer };
  timeoutMs?: number;
  // Route this REST call to a specific profile's backend. Callers embed
  // `?profile=` in `path` themselves for reads (see api/sessions.ts); this
  // pin covers helpers that pass scope separately.
  profile?: string | null;
  // Route this REST call to a specific REGISTERED gateway connection.
  // Explicit 'local' forces this device — unsupported on mobile v1 (no
  // on-device backend) and throws. Omit for the active connection.
  connectionId?: string | null;
  // Passive background read that must never cold-start anything.
  passive?: boolean;
  priority?: 'foreground';
}

export interface HermesConnection {
  baseUrl: string;
  wsUrl: string;
  token: string;
  /** Mobile v1 only ever resolves 'remote' — no pooled local backend on-device. */
  mode: 'local' | 'remote';
  authMode?: 'oauth' | 'token';
  remoteHost?: string;
  remoteKind?: 'cloud' | 'ssh' | 'url';
  profile?: string;
  connectionId?: string;
  registryScoped?: boolean;
}

export interface RegistryConnection {
  id: string;
  label: string;
  baseUrl: string;
  /** Bearer token for URL backends; SSH entries carry host/user instead. */
  token?: string;
  kind: 'ssh' | 'url';
  sshHost?: string;
  sshUser?: string;
  isPrimary?: boolean;
}

interface GatewayWsUrl {
  url: string;
  token: string;
}

// ── Storage: localStorage in the WebView (persists), memory fallback ────────

interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const memoryStore = (): KVStore => {
  const map = new Map<string, string>();
  return {
    get: async (k) => (map.has(k) ? map.get(k)! : null),
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k)
  };
};

const localStorageStore = (): KVStore => {
  try {
    if (typeof localStorage === 'undefined') return memoryStore();
    localStorage.setItem('hermes-mobile.probe', '1');
    localStorage.removeItem('hermes-mobile.probe');
  } catch {
    return memoryStore();
  }
  return {
    get: async (k) => localStorage.getItem(k),
    set: async (k, v) => void localStorage.setItem(k, v),
    remove: async (k) => void localStorage.removeItem(k)
  };
};

// ── Bridge ───────────────────────────────────────────────────────────────────

const REGISTRY_KEY = 'hermes-mobile.connections.v1';
const ACTIVE_KEY = 'hermes-mobile.active-connection.v1';

export class MobileBridgeUnsupported extends Error {
  constructor(surface: string) {
    super(`[hermes-mobile] ${surface} is not available in thin-client v1`);
    this.name = 'MobileBridgeUnsupported';
  }
}

export function normalizeBaseUrl(raw: string): string {
  let value = String(raw || '').trim();
  if (!value) throw new Error('[hermes-mobile] backend URL is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[hermes-mobile] backend URL must be http(s), got ${parsed.protocol}`);
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

export function httpToWs(baseUrl: string, token: string, profile?: null | string): string {
  const parsed = new URL(normalizeBaseUrl(baseUrl));
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const prefix = parsed.pathname.replace(/\/+$/, '');
  const scope = profile ? `&profile=${encodeURIComponent(profile)}` : '';
  return `${scheme}://${parsed.host}${prefix}/api/ws?token=${encodeURIComponent(token)}${scope}`;
}

export function createMobileBridge(opts: {
  store?: KVStore;
  fetchFn?: typeof fetch;
  defaultBaseUrl?: string;
  defaultToken?: string;
}) {
  const store = opts.store ?? localStorageStore();
  const fetchFn = opts.fetchFn ?? fetch;
  const defaultBaseUrl = opts.defaultBaseUrl ?? 'http://127.0.0.1:9119';

  const readRegistry = async (): Promise<RegistryConnection[]> => {
    const raw = await store.get(REGISTRY_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RegistryConnection[]) : [];
    } catch {
      return [];
    }
  };
  const writeRegistry = (rows: RegistryConnection[]) => store.set(REGISTRY_KEY, JSON.stringify(rows));

  const sessionTokenHeaders = (token?: string): Record<string, string> =>
    token ? { 'X-Hermes-Session-Token': token } : {};

  const PHONE_ROW_ID = 'phone-termux';

  const resolveActive = async (): Promise<RegistryConnection> => {
    const [rows, activeId] = await Promise.all([readRegistry(), store.get(ACTIVE_KEY)]);
    const hit = rows.find((r) => r.id === activeId) ?? rows.find((r) => r.isPrimary) ?? rows[0];
    if (hit) return hit;
    // First run: the phone itself. The renderer's own remote-setup UI handles
    // the token entry (it was built for remote backends); authed calls 401
    // until the user pastes the token from the Termux connection card.
    return {
      id: PHONE_ROW_ID,
      label: 'This phone (Termux)',
      baseUrl: defaultBaseUrl,
      kind: 'url',
      token: opts.defaultToken
    };
  };

  const toConnection = (row: RegistryConnection, profile?: null | string): HermesConnection => ({
    baseUrl: normalizeBaseUrl(row.baseUrl),
    wsUrl: httpToWs(row.baseUrl, row.token ?? '', profile ?? null),
    token: row.token ?? '',
    mode: 'remote',
    authMode: 'token',
    remoteHost: row.kind === 'ssh' ? row.sshHost : row.baseUrl,
    remoteKind: row.kind,
    ...(profile ? { profile } : {}),
    connectionId: row.id,
    registryScoped: true
  });

  const listeners = {
    connectionApplied: new Set<() => void>(),
    backendExit: new Set<(payload: { code: number | null }) => void>()
  };

  return {
    // — core: connection resolution (mirrors getConnection/getConnectionFor) —
    async getConnection(profile?: null | string): Promise<HermesConnection> {
      return toConnection(await resolveActive(), profile ?? null);
    },
    async getConnectionFor(payload?: {
      connectionId?: null | string;
      profile?: null | string;
    }): Promise<HermesConnection> {
      if (!payload?.connectionId) return toConnection(await resolveActive(), payload?.profile ?? null);
      const rows = await readRegistry();
      const hit = rows.find((r) => r.id === payload.connectionId);
      if (!hit) throw new Error(`[hermes-mobile] unknown connection ${payload.connectionId}`);
      return toConnection(hit, payload.profile ?? null);
    },
    async getGatewayWsUrl(profile?: null | string): Promise<GatewayWsUrl> {
      const row = await resolveActive();
      return { url: httpToWs(row.baseUrl, row.token ?? '', profile ?? null), token: row.token ?? '' };
    },
    async getGatewayWsUrlFor(payload?: {
      connectionId?: null | string;
    }): Promise<GatewayWsUrl> {
      const conn = await this.getConnectionFor({ connectionId: payload?.connectionId });
      return { url: conn.wsUrl, token: conn.token };
    },

    // — core: REST dispatch (mirrors hermesDesktop.api / api-transport.ts) —
    // Verb-gated retry, desktop policy: idempotent verbs retry on transient
    // transport failure; POST/PUT/PATCH/DELETE never retry (a reset after the
    // body went out may already have been processed — retrying double-submits
    // prompts). 401/403 surfaces immediately for reauth; never retried.
    async api<T>(request: HermesApiRequest): Promise<T> {
      const rows = await readRegistry();
      let row: RegistryConnection | undefined;
      if (request.connectionId) {
        if (request.connectionId === 'local') {
          throw new MobileBridgeUnsupported("connectionId 'local' (no on-device backend in v1)");
        }
        row = rows.find((r) => r.id === request.connectionId);
        if (!row) throw new Error(`[hermes-mobile] unknown connection ${request.connectionId}`);
      } else {
        row = await resolveActive();
      }

      let path = request.path;
      if (request.profile && !path.includes('profile=')) {
        path += `${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(request.profile)}`;
      }
      const url = `${normalizeBaseUrl(row.baseUrl)}${path}`;
      const method = (request.method ?? 'GET').toUpperCase();
      const idempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

      let body: BodyInit | undefined;
      const headers: Record<string, string> = { ...sessionTokenHeaders(row.token) };
      if (request.upload) {
        const form = new FormData();
        form.append(
          'file',
          new Blob([request.upload.bytes], { type: request.upload.contentType ?? 'application/octet-stream' }),
          request.upload.filename
        );
        body = form;
      } else if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(request.body);
      }

      const attempt = async (): Promise<T> => {
        const ctrl = new AbortController();
        const timer =
          request.timeoutMs != null ? setTimeout(() => ctrl.abort(), request.timeoutMs) : null;
        try {
          const res = await fetchFn(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctrl.signal });
          const text = await res.text();
          if (!res.ok) {
            const err = new Error(`${res.status}: ${text.slice(0, 300)}`);
            (err as { statusCode?: number }).statusCode = res.status;
            throw err;
          }
          if (text.trimStart().startsWith('<')) {
            throw new Error(
              `Expected JSON from ${url} but got HTML (status ${res.status}). The endpoint is likely missing on the Hermes backend.`
            );
          }
          return JSON.parse(text) as T;
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      try {
        return await attempt();
      } catch (e) {
        const transient = e instanceof TypeError; // DNS/refused/reset surface as TypeError in fetch
        const status = Number((e as { statusCode?: unknown }).statusCode);
        if (idempotent && transient && !Number.isInteger(status)) {
          await new Promise((r) => setTimeout(r, 400));
          return await attempt();
        }
        throw e;
      }
    },

    // — core: connection registry (mirrors hermesDesktop.connections) —
    connections: {
      async list(): Promise<{ connections: RegistryConnection[]; primaryId: string | null }> {
        const rows = await readRegistry();
        return { connections: rows, primaryId: rows.find((r) => r.isPrimary)?.id ?? rows[0]?.id ?? null };
      },
      async save(input: Omit<RegistryConnection, 'id'> & { id?: string }) {
        const rows = await readRegistry();
        const id = input.id ?? `conn_${Date.now().toString(36)}`;
        const next = rows.some((r) => r.id === id)
          ? rows.map((r) => (r.id === id ? { ...r, ...input, id } : r))
          : [...rows, { ...input, id }];
        await writeRegistry(next);
        return { ok: true as const, connection: next.find((r) => r.id === id)!, registry: next };
      },
      async remove(id: string) {
        const next = (await readRegistry()).filter((r) => r.id !== id);
        await writeRegistry(next);
        if ((await store.get(ACTIVE_KEY)) === id) await store.remove(ACTIVE_KEY);
        listeners.connectionApplied.forEach((fn) => fn());
        return { ok: true as const, registry: next };
      },
      async setPrimary(id: string) {
        const next = (await readRegistry()).map((r) => ({ ...r, isPrimary: r.id === id }));
        await writeRegistry(next);
        await store.set(ACTIVE_KEY, id);
        listeners.connectionApplied.forEach((fn) => fn());
        return { ok: true as const, registry: next };
      },
      async test(id: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        const rows = await readRegistry();
        const hit = rows.find((r) => r.id === id);
        if (!hit) return { ok: false, latencyMs: 0, error: 'unknown connection' };
        const t0 = Date.now();
        try {
          const res = await fetchFn(`${normalizeBaseUrl(hit.baseUrl)}/api/status`, {
            headers: { ...sessionTokenHeaders(hit.token) }
          });
          if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, error: `status ${res.status}` };
          return { ok: true, latencyMs: Date.now() - t0 };
        } catch (e) {
          return { ok: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
        }
      }
    },

    // — compat: single-connection config screen talks through these —
    async getConnectionConfig() {
      const row = await resolveActive().catch(() => null);
      return { mode: 'remote' as const, profile: null as null, remoteUrl: row?.baseUrl ?? '', remoteTokenSet: !!row?.token };
    },
    async saveConnectionConfig(input: { remoteUrl: string; remoteToken?: string }) {
      const rows = await readRegistry();
      const primary = rows.find((r) => r.isPrimary) ?? rows[0];
      if (primary) {
        await this.connections.save({ ...primary, baseUrl: input.remoteUrl, token: input.remoteToken ?? primary.token });
      } else {
        const saved = await this.connections.save({ label: 'Primary backend', baseUrl: input.remoteUrl, kind: 'url', token: input.remoteToken });
        await this.connections.setPrimary(saved.connection.id);
      }
      return this.getConnectionConfig();
    },
    applyConnectionConfig(input: { remoteUrl: string; remoteToken?: string }) {
      return this.saveConnectionConfig(input);
    },
    // One-tap connect from the pasted Termux connection card (URL + token).
    // Upserts the phone row and makes it primary. SSH rows keep host/user for
    // CLI parity; the data plane is always the serve URL (loopback locally).
    async quickConnect(input: {
      baseUrl: string;
      token?: string;
      label?: string;
      kind?: 'ssh' | 'url';
      sshHost?: string;
      sshUser?: string;
    }): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const saved = await this.connections.save({
        id: PHONE_ROW_ID,
        label: input.label ?? 'This phone (Termux)',
        baseUrl,
        kind: input.kind ?? 'url',
        token: input.token,
        ...(input.sshHost ? { sshHost: input.sshHost } : {}),
        ...(input.sshUser ? { sshUser: input.sshUser } : {})
      });
      await this.connections.setPrimary(saved.connection.id);
      const probed = await this.connections.test(saved.connection.id);
      listeners.connectionApplied.forEach((fn) => fn());
      return probed;
    },
    async testConnectionConfig(input: { remoteUrl: string; remoteToken?: string }) {
      const t0 = Date.now();
      try {
        const res = await fetchFn(`${normalizeBaseUrl(input.remoteUrl)}/api/status`, {
          headers: { ...sessionTokenHeaders(input.remoteToken) }
        });
        return { ok: res.ok, latencyMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false as const, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // — compat: roster + routes (Bot Mode union roster reads these) —
    async getAgentRoster() {
      const rows = await readRegistry();
      const settled = await Promise.allSettled(
        rows.map(async (row) => {
          const res = await fetchFn(`${normalizeBaseUrl(row.baseUrl)}/api/profiles`, {
            headers: { ...sessionTokenHeaders(row.token) }
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          return { connectionId: row.id, profiles: (await res.json()) as unknown };
        })
      );
      return settled
        .filter((s): s is PromiseFulfilledResult<{ connectionId: string; profiles: unknown }> => s.status === 'fulfilled')
        .map((s) => s.value);
    },
    async getProfileRoutes(profiles: string[]) {
      const rows = await readRegistry();
      return rows.flatMap((row) =>
        profiles.map((profile) => ({ connectionId: row.id, mode: 'remote' as const, profile, targetProfile: profile }))
      );
    },

    // — compat: lifecycle —
    async revalidateConnection(): Promise<{ ok: boolean; rebuilt: boolean }> {
      try {
        await resolveActive();
        return { ok: true, rebuilt: false };
      } catch {
        return { ok: false, rebuilt: false };
      }
    },
    async touchBackend(): Promise<{ ok: boolean }> {
      return { ok: true };
    },
    onConnectionApplied(cb: () => void): () => void {
      listeners.connectionApplied.add(cb);
      return () => void listeners.connectionApplied.delete(cb);
    },
    onBackendExit(cb: (payload: { code: number | null }) => void): () => void {
      listeners.backendExit.add(cb);
      return () => void listeners.backendExit.delete(cb);
    },

    // — device surfaces: real impls where the phone can, safe neutrals —
    // Rule: every member the renderer is known to call directly MUST exist.
    // `?.`-gated optionals with working fallbacks stay absent (their absence
    // IS the fallback signal). Writes/mutations that need Electron throw
    // loudly; reads return neutrals.
    windowControls: {
      custom: false,
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined
    },
    glassSupported: false,
    translucencySupported: false,
    localModelsEnabled: false,
    guestOnboardingEnabled: false,
    async getBootProgress() {
      return { error: null, fakeMode: false, message: '', phase: 'ready', progress: 1, running: false, retryable: false };
    },
    onBootProgress(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    onPreviewFileChanged(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    async watchPreviewFile(url: string) {
      return { id: 'mobile-no-watch', path: url };
    },
    async stopPreviewFileWatch(_id: string): Promise<boolean> {
      return false;
    },
    async normalizePreviewTarget(_target: string, _baseDir?: string) {
      return null;
    },
    async getVersion() {
      return { appVersion: '0.2.0-mobile', platform: 'android', electronVersion: '', nodeVersion: '', hermesRoot: '' };
    },
    profile: {
      async getDefault() {
        return null;
      },
      async setDefault(route: unknown) {
        return route;
      },
      onDefaultChanged(_cb: (r: unknown) => void): () => void {
        return () => undefined;
      },
      async get() {
        return { profile: await store.get('hermes-mobile.profile') };
      },
      async remember(name: string | null) {
        if (name) await store.set('hermes-mobile.profile', name);
        else await store.remove('hermes-mobile.profile');
        return { profile: name };
      },
      async set(name: string | null) {
        if (name) await store.set('hermes-mobile.profile', name);
        else await store.remove('hermes-mobile.profile');
        return { profile: name };
      }
    },
    async openExternal(url: string): Promise<void> {
      window.open(url, '_blank', 'noopener');
    },
    async openPreviewInBrowser(url: string): Promise<void> {
      window.open(url, '_blank', 'noopener');
    },
    async fetchLinkTitle(url: string): Promise<string> {
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
        const html = await res.text();
        const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return (m ? m[1] : '').trim();
      } catch {
        return '';
      }
    },
    async resolveFavicon(_url: string): Promise<string> {
      return '';
    },
    async notify(_payload: unknown): Promise<boolean> {
      return true;
    },
    async claimAmbientCue(_key: string): Promise<boolean> {
      return true;
    },
    async writeClipboard(text: string): Promise<boolean> {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    async readClipboard(): Promise<string> {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    },
    async getPathForFile(file: File): Promise<string> {
      return file?.name ?? '';
    },
    async claimStartupLatency(): Promise<null> {
      return null;
    },
    async requestMicrophoneAccess(): Promise<boolean> {
      return false;
    },
    async readWindowBelow() {
      return null;
    },
    async sanitizeWorkspaceCwd(cwd?: null | string) {
      return { cwd: cwd ?? '', sanitized: false };
    },
    settings: {
      async getDefaultProjectDir() {
        return { defaultLabel: '', dir: null, resolvedCwd: '' };
      },
      async pickDefaultProjectDir() {
        return { canceled: true, dir: null };
      },
      async setDefaultProjectDir(dir: null | string) {
        return { dir };
      }
    },
    zoom: {
      async get() {
        return { level: 0, percent: 100 };
      },
      setPercent(_percent: number): void { undefined; },
      onChanged(_cb: (p: unknown) => void): () => void {
        return () => undefined;
      }
    },
    async findInPage(_query: string): Promise<{ count: number }> {
      return { count: 0 };
    },
    async stopFindInPage(): Promise<void> { undefined; },
    onFoundInPage(_cb: (r: unknown) => void): () => void {
      return () => undefined;
    },
    onOpenFindBarRequested(_cb: () => void): () => void {
      return () => undefined;
    },
    onContextMenuSpellcheck(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    async contextMenuEdit(_command: 'copy' | 'cut' | 'paste' | 'selectAll'): Promise<void> { undefined; },
    async contextMenuCopyImage(): Promise<void> { undefined; },
    async contextMenuSpellcheck(_action: unknown): Promise<void> { undefined; },
    updates: {
      async check() {
        return { supported: false };
      },
      async apply() {
        return { ok: false, error: 'updates are store-delivered on mobile' };
      },
      async getBranch() {
        return { branch: 'mobile' };
      },
      async setBranch(name: string) {
        return { branch: name };
      },
      onProgress(_cb: (p: unknown) => void): () => void {
        return () => undefined;
      }
    },
    uninstall: {
      async summary() {
        return { code_removal_allowed: false, hermes_home: '', agent_installed: false, gui_installed: false, source_built_artifacts: [], packaged_app_paths: [], userdata_dir: '', userdata_exists: false, platform: 'android' };
      },
      async run() {
        return { ok: false, error: 'uninstall from Android Settings' };
      }
    },
    themes: {
      async fetchMarketplace(extensionId: string) {
        return { extensionId, displayName: '', themes: [] };
      },
      async searchMarketplace(_query: string) {
        return [];
      }
    },
    async revealLogs() {
      return { ok: false, path: '', error: 'see Termux ~/.hermes/logs' };
    },
    async getRecentLogs() {
      return { path: '', lines: [] };
    },
    reportRendererError(report: unknown): void {
      console.error('[hermes-mobile][renderer]', report);
    },
    logLine(line: string): void {
      console.log('[hermes-mobile]', line);
    },
    async readDir(_path: string) {
      return { entries: [] };
    },
    async gitRoot(_path: string): Promise<null> {
      return null;
    },
    async revealPath(_path: string): Promise<boolean> {
      return false;
    },
    async openDir(_path: string) {
      return { ok: false, error: 'no OS file manager bridge on mobile v0.2' };
    },
    async renamePath(_path: string, _newName: string): Promise<never> {
      throw new MobileBridgeUnsupported('renamePath');
    },
    async writeTextFile(_path: string, _content: string): Promise<never> {
      throw new MobileBridgeUnsupported('writeTextFile');
    },
    async trashPath(_path: string): Promise<never> {
      throw new MobileBridgeUnsupported('trashPath');
    },
    async readFileText(filePath: string) {
      return { path: filePath, text: '', truncated: false };
    },
    async desktopPluginsRoot(): Promise<string> {
      return '';
    },
    async reconcileDesktopPlugins(): Promise<string[]> {
      return [];
    },
    async logsRoot(_profile?: string): Promise<string> {
      return '';
    },
    async agentPluginsRoot(): Promise<string> {
      return '';
    },
    async selectPaths(_options?: unknown): Promise<never> {
      throw new MobileBridgeUnsupported('selectPaths (Capacitor FilePicker lands in v0.3)');
    },
    async saveImageFromUrl(_url: string): Promise<never> {
      throw new MobileBridgeUnsupported('saveImageFromUrl');
    },
    async saveImageBuffer(_data: unknown, _ext: string, _name?: string): Promise<never> {
      throw new MobileBridgeUnsupported('saveImageBuffer');
    },
    async savePastedText(_text: string): Promise<never> {
      throw new MobileBridgeUnsupported('savePastedText');
    },
    async saveClipboardImage(): Promise<never> {
      throw new MobileBridgeUnsupported('saveClipboardImage');
    },
    async capturePreview(_payload: unknown): Promise<never> {
      throw new MobileBridgeUnsupported('capturePreview');
    },
    async reachPreviewUrl(url: string): Promise<string> {
      return url;
    },
    setActiveWork(_payload: unknown): void { undefined; },
    setTitleBarTheme(_payload: unknown): void { undefined; },
    setNativeTheme(_mode: 'dark' | 'light' | 'system'): void { undefined; },
    setTranslucency(_payload: unknown): void { undefined; },
    setKeepAwake(_on: boolean): void { undefined; },
    setDisableF12(_blocked: boolean): void { undefined; },
    setF12ShortcutActive(_active: boolean): void { undefined; },
    onF12Shortcut(_cb: (i: unknown) => void): () => void {
      return () => undefined;
    },
    setPreviewShortcutActive(_active: boolean): void { undefined; },
    setActiveConnectionRoute(_route: unknown): void { undefined; },
    onClosePreviewRequested(_cb: () => void): () => void {
      return () => undefined;
    },
    onPreviewNav(_cb: (c: unknown) => void): () => void {
      return () => undefined;
    },
    onOpenFolderRequested(_cb: () => void): () => void {
      return () => undefined;
    },
    onOpenUpdatesRequested(_cb: () => void): () => void {
      return () => undefined;
    },
    onDeepLink(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    async signalDeepLinkReady() {
      return { ok: true };
    },
    onWindowStateChanged(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    onFocusSession(_cb: (id: string) => void): () => void {
      return () => undefined;
    },
    onNotificationAction(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    onNotificationActivate(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    onPoolBackendRetiring(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    onPowerResume(_cb: () => void): () => void {
      return () => undefined;
    },
    async getOnBattery(): Promise<boolean> {
      return false;
    },
    onBatteryChanged(_cb: (b: boolean) => void): () => void {
      return () => undefined;
    },
    async getBootstrapState() {
      return { bootstrapNeeded: false };
    },
    async probeLocalBackend() {
      return { bootstrapNeeded: false };
    },
    async continueBootstrapLocal() {
      return { ok: true };
    },
    async recycleBackend(_profile?: null | string) {
      return { ok: false };
    },
    async resetBootstrap() {
      return { ok: false };
    },
    async repairBootstrap() {
      return { ok: false, error: 'no bootstrap on mobile' };
    },
    async cancelBootstrap() {
      return { ok: false, cancelled: false };
    },
    onBootstrapEvent(_cb: (p: unknown) => void): () => void {
      return () => undefined;
    },
    async getSyncStatus() {
      return null;
    },
    async getRemoteDisplayReason(): Promise<null> {
      return null;
    },
    async getPoolLimits() {
      return { maxBackends: 1, idleMs: 0 };
    },
    async setPoolLimits(limits: { maxBackends?: number; idleMs?: number }) {
      return { ok: true, limits: { maxBackends: limits.maxBackends ?? 1, idleMs: limits.idleMs ?? 0 } };
    },
    minimizeToTray: {
      async get() {
        return { enabled: false, available: false };
      },
      async set(on: boolean) {
        return { enabled: on, available: false };
      },
      onChanged(_cb: (s: unknown) => void): () => void {
        return () => undefined;
      }
    },
    mcpOauth: {
      async listen() {
        return { id: '', redirectUri: '' };
      },
      async wait(_id: string, _timeoutMs?: number) {
        return { code: null, error: 'oauth not supported on mobile v0.2', iss: null, state: null };
      },
      async cancel(_id: string): Promise<boolean> {
        return false;
      }
    },
    cloud: {
      async status() {
        return { signedIn: false };
      },
      async login(): Promise<never> {
        throw new MobileBridgeUnsupported('cloud.login');
      },
      async logout() {
        return { signedIn: false, ok: true };
      },
      async discover(_org?: string) {
        return { ok: false, error: 'cloud discovery not supported on mobile v0.2' };
      },
      async agentSignIn(_url: string): Promise<never> {
        throw new MobileBridgeUnsupported('cloud.agentSignIn');
      }
    },
    async sshConfigHosts() {
      return { hosts: [] };
    },
    async sshResolveHost(host: string) {
      return { ok: false, host, error: 'SSH resolution needs the Termux setup (see connection card)' };
    },
    async probeConnectionConfig(remoteUrl: string) {
      const t0 = Date.now();
      try {
        const res = await fetchFn(`${normalizeBaseUrl(remoteUrl)}/api/status`, {
          signal: AbortSignal.timeout(10000)
        });
        return { ok: res.ok, latencyMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async oauthLoginConnectionConfig(_remoteUrl: string): Promise<never> {
      throw new MobileBridgeUnsupported('oauthLogin (use token mode on mobile v0.2)');
    },
    async oauthLogoutConnectionConfig(_remoteUrl: string) {
      return { ok: true };
    },
    async getSecretStorageEncryption() {
      return { on: false };
    },
    async setSecretStorageEncryption(_on: boolean) {
      return { on: false };
    },
    async probePluginRepo(_payload: unknown) {
      return { ok: false, agent: false, desktop: false, error: 'plugin install not supported on mobile v0.2' };
    },
    async installDesktopPlugin(_payload: unknown) {
      return { ok: false, error: 'plugin install not supported on mobile v0.2' };
    },
    async removeDesktopPlugin(_payload: unknown) {
      return { ok: false, error: 'plugin install not supported on mobile v0.2' };
    },
    // — local machine access: repos live on the backend host, reached via REST —
    terminal: {
      async attach(_id: string): Promise<boolean> {
        return false;
      },
      async cwd(_id: string): Promise<null> {
        return null;
      },
      async dispose(_id: string): Promise<boolean> {
        return false;
      },
      onData(_id: string, _cb: (d: string) => void): () => void {
        return () => undefined;
      },
      onExit(_id: string, _cb: (e: unknown) => void): () => void {
        return () => undefined;
      },
      async resize(_id: string, _size: { cols: number; rows: number }): Promise<boolean> {
        return false;
      },
      async start(_options?: unknown): Promise<never> {
        throw new MobileBridgeUnsupported('terminal.start (use the backend terminal pane via gateway)');
      },
      async write(_id: string, _data: string): Promise<boolean> {
        return false;
      }
    },
    git: {
      async worktreeList(_repoPath: string) {
        return [];
      },
      async worktreeAdd(): Promise<never> {
        throw new MobileBridgeUnsupported('git.worktreeAdd');
      },
      async worktreeRemove(): Promise<never> {
        throw new MobileBridgeUnsupported('git.worktreeRemove');
      },
      async branchSwitch(): Promise<never> {
        throw new MobileBridgeUnsupported('git.branchSwitch');
      },
      async branchList(_repoPath: string) {
        return [];
      },
      async baseBranchList(_repoPath: string) {
        return [];
      },
      async repoStatus(_repoPath: string) {
        return null;
      },
      async fileDiff(_repoPath: string, _filePath: string): Promise<string> {
        return '';
      },
      review: {
        async list(_repoPath: string) {
          return { files: [], base: null };
        },
        async diff(): Promise<string> {
          return '';
        },
        async stage(): Promise<{ ok: boolean }> {
          return { ok: false };
        },
        async unstage(): Promise<{ ok: boolean }> {
          return { ok: false };
        },
        async revert(): Promise<{ ok: boolean }> {
          return { ok: false };
        },
        async revParse(): Promise<null> {
          return null;
        },
        async commit(): Promise<{ ok: boolean }> {
          return { ok: false };
        },
        async commitContext(_repoPath: string) {
          return { diff: '', recent: '' };
        },
        async push(): Promise<{ ok: boolean }> {
          return { ok: false };
        },
        async shipInfo(_repoPath: string) {
          return { ghReady: false, pr: null };
        },
        async prList() {
          return { ghReady: false, prs: [] };
        },
        async createPr(): Promise<never> {
          throw new MobileBridgeUnsupported('git.createPr');
        }
      },
      async scanRepos(_roots: string[], _options?: unknown) {
        return [];
      }
    }
  };
}

export type MobileBridge = ReturnType<typeof createMobileBridge>;

/** Install the bridge as window.hermesDesktop before the renderer boots. */
export function installMobileBridge(
  opts: Parameters<typeof createMobileBridge>[0] = {}
): MobileBridge {
  const bridge = createMobileBridge(opts);
  (globalThis as unknown as { hermesDesktop: MobileBridge }).hermesDesktop = bridge;
  return bridge;
}
