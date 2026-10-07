// Optional real Chromium regression check; no BatchData or authenticated API calls.
// Start Vite first, then: node scripts/check-map-rendering-browser.mjs <vite-url>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:5179';
const executable = process.env.CHROME_BIN || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);
assert(executable, 'Set CHROME_BIN to an installed Chromium browser');
const profile = await mkdtemp(join(tmpdir(), 'firstknock-map-check-'));
const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true });
let socket;
try {
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Chromium did not start')), 15000);
        let stderr = '';
        browser.stderr.on('data', data => {
            stderr += data;
            const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        browser.on('error', reject);
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (!message.id) return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`${method} timed out`)); }, 30000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
    for (const [name, width, height, kind] of [['desktop', 1440, 900, 'manager'], ['tablet-manager', 820, 1180, 'manager'], ['tablet-rep', 820, 1180, 'rep'], ['phone-manager', 390, 844, 'manager'], ['phone-rep', 390, 844, 'rep']]) {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: name === 'desktop' ? 1 : 2, mobile: name !== 'desktop' }, sessionId);
        if (name !== 'desktop') await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }, sessionId);
        await send('Page.navigate', { url: `${base}/test/fixtures/map-rendering.html` }, sessionId);
        if (process.argv[3]) {
            await send('Runtime.evaluate', { expression: `(async () => { for (let i = 0; i < 100 && !window.previewMap; i++) await new Promise(r => setTimeout(r, 100)); await window.previewMap('${kind}'); })()`, awaitPromise: true }, sessionId);
            const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
            await mkdir(process.argv[3], { recursive: true });
            await writeFile(join(process.argv[3], `${name}.png`), Buffer.from(screenshot.data, 'base64'));
        }
        const result = await send('Runtime.evaluate', { expression: `(async () => {
            for (let i = 0; i < 100 && !window.runMapChecks; i++) await new Promise(r => setTimeout(r, 100));
            if (!window.runMapChecks) throw Error('Map fixture failed to load');
            return window.runMapChecks('${kind}');
        })()`, awaitPromise: true, returnByValue: true }, sessionId);
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        console.log(JSON.stringify({ viewport: name, width, height, ...result.result.value }));
        await send('Target.closeTarget', { targetId });
    }
} finally {
    socket?.close();
    if (browser.exitCode === null) {
        const stopped = new Promise(done => browser.once('exit', done));
        browser.kill();
        await stopped;
    }
    // Delete only this runner's freshly created, resolved temporary profile.
    if (resolve(profile).startsWith(resolve(tmpdir()) + '/') || resolve(profile).startsWith(resolve(tmpdir()) + '\\')) {
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}
