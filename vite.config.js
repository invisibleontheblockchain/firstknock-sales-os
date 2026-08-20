import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

function pwaReleasePlugin() {
  const release = `fk-${Date.now().toString(36)}`;
  return {
    name: 'firstknock-pwa-release',
    transformIndexHtml(html) {
      return html.replaceAll('__FK_BUILD_RELEASE__', release);
    },
    closeBundle() {
      const worker = `const RELEASE = '${release}';\n\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (event) => event.waitUntil((async () => {\n  const names = await caches.keys();\n  await Promise.all(names.map((name) => caches.delete(name)));\n  await self.clients.claim();\n})()));\nself.addEventListener('message', (event) => {\n  if (event.data === 'skipWaiting' || event.data?.type === 'SKIP_WAITING') self.skipWaiting();\n});\nself.addEventListener('fetch', (event) => {\n  if (event.request.mode === 'navigate') {\n    event.respondWith(fetch(event.request, { cache: 'no-store' }));\n  }\n});\n`;
      writeFileSync(resolve(process.cwd(), 'dist/sw.js'), worker);
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  plugins: [
    pwaReleasePlugin(),
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