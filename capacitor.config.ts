import type { CapacitorConfig } from '@capacitor/cli';

// Phase 1 shell: the WebView loads the Hermes Desktop renderer Vite build
// (webDir) with window.hermesDesktop provided by src/mobile-bridge.ts
// instead of Electron's preload. No local backend on the phone in v1 —
// every connection is remote (URL+token, SSH host running hermes serve,
// or Hermes Cloud), which the desktop renderer already supports.
const config: CapacitorConfig = {
  appId: 'com.hermes.mobile',
  appName: 'Hermes Mobile',
  webDir: 'dist',
  backgroundColor: '#0a0a0f',
  android: {
    allowMixedContent: false
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_notify',
      iconColor: '#7c5cff'
    }
  }
};

export default config;
