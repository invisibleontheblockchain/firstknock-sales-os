import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

// Stamped into the bundle so an installed PWA can prove WHICH build it is
// running. An iOS Home Screen app can serve a cached shell indefinitely, so a
// layout report from a device is meaningless without the commit it came from.
const buildSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    const ciSha = process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '';
    return ciSha ? ciSha.slice(0, 7) : 'unknown';
  }
})();

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  define: {
    'import.meta.env.VITE_FK_BUILD_SHA': JSON.stringify(buildSha),
    'import.meta.env.VITE_FK_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    base44({
      // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
      // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
      legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
      hmrNotifier: true,
      navigationNotifier: true,
      visualEditAgent: true
    }),
    react(),
  ],
  build: {
    rollupOptions: {
      input: {
        app: resolve(process.cwd(), 'index.html'),
        hq: resolve(process.cwd(), 'hq/index.html'),
      },
    },
  },
});
