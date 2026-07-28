import React from 'react';

/**
 * TEMPORARY diagnostics for the installed Home Screen PWA. REMOVE once the
 * header geometry question is settled.
 *
 * Why this exists: a standalone iOS web app is a different display surface from
 * a Safari tab. It has no browser chrome, it honours
 * `apple-mobile-web-app-status-bar-style`, and it reports a real
 * `env(safe-area-inset-top)`. None of that is reproducible in a desktop browser
 * at a phone-sized viewport, where the inset is always 0 — so browser
 * measurements cannot confirm or refute a standalone-only layout report.
 *
 * The build SHA is the important field: an installed PWA can serve a cached
 * shell indefinitely, so a measurement is only meaningful alongside the commit
 * that produced it.
 */

const BUILD_SHA = import.meta.env.VITE_FK_BUILD_SHA || 'unknown';
const BUILD_TIME = import.meta.env.VITE_FK_BUILD_TIME || 'unknown';
const DISMISS_KEY = 'fk_diag_dismissed_sha';

/** Reads a real px value for an env() inset, which JS cannot query directly. */
function measureInset(side) {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-${side})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).paddingTop;
  probe.remove();
  return value;
}

const px = (value) => (typeof value === 'number' ? `${Math.round(value * 10) / 10}px` : String(value));

export function collectStandaloneDiagnostics() {
  const el = (selector) => document.querySelector(selector);
  const headerEl = el('[data-fk-header]');
  const header = headerEl?.getBoundingClientRect() ?? null;
  const row = el('[data-fk-header-row]')?.getBoundingClientRect() ?? null;
  const main = el('[data-fk-main]')?.getBoundingClientRect() ?? null;
  const headerStyle = headerEl ? getComputedStyle(headerEl) : null;
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;

  return {
    build_sha: BUILD_SHA,
    build_time: BUILD_TIME,
    display_mode_standalone: window.matchMedia?.('(display-mode: standalone)')?.matches ?? null,
    navigator_standalone: window.navigator.standalone ?? null,
    env_safe_area_inset_top: measureInset('top'),
    env_safe_area_inset_bottom: measureInset('bottom'),
    window_innerHeight: window.innerHeight,
    documentElement_clientHeight: document.documentElement.clientHeight,
    visualViewport_height: vv ? Math.round(vv.height * 10) / 10 : null,
    visualViewport_offsetTop: vv ? Math.round(vv.offsetTop * 10) / 10 : null,
    header_top: header ? px(header.top) : 'not found',
    header_bottom: header ? px(header.bottom) : 'not found',
    header_total_height: header ? px(header.height) : 'not found',
    // The three values that decide whether CSS owns the inset correctly:
    // padding-top should EQUAL env(safe-area-inset-top), and total height should
    // equal that inset + the row + the border.
    header_computed_padding_top: headerStyle ? headerStyle.paddingTop : 'not found',
    header_border_bottom_width: headerStyle ? headerStyle.borderBottomWidth : 'not found',
    inner_row_height: row ? px(row.height) : 'not found',
    main_map_top: main ? px(main.top) : 'not found',
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    measured_at: new Date().toISOString(),
  };
}

/**
 * Service-worker and cache state, which decides whether a stale shell is being
 * served. Async, so it is merged into the panel once resolved.
 */
export async function collectWorkerDiagnostics() {
  const out = {
    service_worker_controller_url: null,
    registration_active_url: null,
    registration_active_state: null,
    registration_waiting_url: null,
    registration_waiting_state: null,
    registration_installing_url: null,
    registration_installing_state: null,
    cache_storage_names: null,
  };

  try {
    if ('serviceWorker' in navigator) {
      out.service_worker_controller_url = navigator.serviceWorker.controller?.scriptURL ?? 'no controller';
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        out.registration_active_url = registration.active?.scriptURL ?? null;
        out.registration_active_state = registration.active?.state ?? null;
        out.registration_waiting_url = registration.waiting?.scriptURL ?? null;
        out.registration_waiting_state = registration.waiting?.state ?? null;
        out.registration_installing_url = registration.installing?.scriptURL ?? null;
        out.registration_installing_state = registration.installing?.state ?? null;
      } else {
        out.registration_active_state = 'no registration';
      }
    } else {
      out.service_worker_controller_url = 'serviceWorker unsupported';
    }
  } catch (error) {
    out.service_worker_controller_url = `error: ${error?.message || error}`;
  }

  try {
    out.cache_storage_names = 'caches' in window ? (await caches.keys()).join(', ') || '(none)' : 'unsupported';
  } catch (error) {
    out.cache_storage_names = `error: ${error?.message || error}`;
  }

  return out;
}

export default function StandaloneDiagnostics() {
    const [data, setData] = React.useState(null);
    const [workerData, setWorkerData] = React.useState(null);
    const [dismissed, setDismissed] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    // `?fkdiag` is an escape hatch so the panel can be opened in a normal tab
    // for comparison against the standalone numbers. Standalone alone is what
    // shows it unprompted.
    const shouldShow = React.useMemo(() => {
        if (typeof window === 'undefined') return false;
        const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
            || window.navigator.standalone === true;
        const forced = new URLSearchParams(window.location.search).has('fkdiag');
        return standalone || forced;
    }, []);

    React.useEffect(() => {
        if (!shouldShow) return undefined;
        try {
            if (localStorage.getItem(DISMISS_KEY) === BUILD_SHA) setDismissed(true);
        } catch { /* storage unavailable — just show it */ }

        // Measure after paint so the header has its final box. Remeasured on the
        // events where a standalone app's viewport actually changes: returning
        // from the app switcher (pageshow, possibly from the back/forward cache),
        // regaining visibility, rotating, and once more at 500ms in case the
        // status bar settles after first paint.
        const measure = () => setData(collectStandaloneDiagnostics());
        const onVisibility = () => { if (document.visibilityState === 'visible') measure(); };

        const frame = requestAnimationFrame(() => requestAnimationFrame(measure));
        const settle = setTimeout(measure, 500);
        window.addEventListener('resize', measure);
        window.addEventListener('pageshow', measure);
        window.addEventListener('orientationchange', measure);
        document.addEventListener('visibilitychange', onVisibility);
        window.visualViewport?.addEventListener('resize', measure);

        let cancelled = false;
        collectWorkerDiagnostics().then((worker) => {
            if (!cancelled) setWorkerData(worker);
        });

        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
            clearTimeout(settle);
            window.removeEventListener('resize', measure);
            window.removeEventListener('pageshow', measure);
            window.removeEventListener('orientationchange', measure);
            document.removeEventListener('visibilitychange', onVisibility);
            window.visualViewport?.removeEventListener('resize', measure);
        };
    }, [shouldShow]);

    if (!shouldShow || dismissed || !data) return null;

    const report = { ...data, ...(workerData || { service_worker: 'collecting…' }) };

    const copy = async () => {
        const text = JSON.stringify(report, null, 2);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Clipboard is unavailable in some standalone contexts; select-to-copy
            // still works because the values are rendered as plain text.
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const dismiss = () => {
        try { localStorage.setItem(DISMISS_KEY, BUILD_SHA); } catch { /* ignore */ }
        setDismissed(true);
    };

    return (
        <div
            className="fixed left-2 right-2 z-[99999] rounded-xl border border-[#39FF4A]/40 bg-black/95 p-3 font-mono text-[10px] leading-relaxed text-[#39FF4A] shadow-2xl"
            style={{ top: 'calc(env(safe-area-inset-top) + 0.5rem)', maxHeight: '60dvh', overflowY: 'auto' }}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-bold tracking-wide">FK HEADER DIAGNOSTICS</span>
                <span className="flex gap-2">
                    <button type="button" onClick={copy} className="rounded border border-[#39FF4A]/40 px-2 py-1">
                        {copied ? 'copied' : 'copy'}
                    </button>
                    <button type="button" onClick={dismiss} className="rounded border border-white/25 px-2 py-1 text-white/70">
                        hide
                    </button>
                </span>
            </div>
            <table>
                <tbody>
                    {Object.entries(report).map(([key, value]) => (
                        <tr key={key}>
                            <td className="pr-3 align-top text-white/55">{key}</td>
                            <td className="align-top break-all">{String(value)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
