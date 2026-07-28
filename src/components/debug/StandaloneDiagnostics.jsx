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
  const rect = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.getBoundingClientRect() : null;
  };
  const header = rect('[data-fk-header]');
  const row = rect('[data-fk-header-row]');
  const main = rect('[data-fk-main]');
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
    inner_row_height: row ? px(row.height) : 'not found',
    main_map_top: main ? px(main.top) : 'not found',
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

export default function StandaloneDiagnostics() {
    const [data, setData] = React.useState(null);
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

        // Measure after paint so the header has its final box.
        const measure = () => setData(collectStandaloneDiagnostics());
        const frame = requestAnimationFrame(() => requestAnimationFrame(measure));
        window.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('resize', measure);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('resize', measure);
        };
    }, [shouldShow]);

    if (!shouldShow || dismissed || !data) return null;

    const copy = async () => {
        const text = JSON.stringify(data, null, 2);
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
                    {Object.entries(data).map(([key, value]) => (
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
