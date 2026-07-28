import React from 'react';

/**
 * TEMPORARY diagnostics for the installed Home Screen PWA. REMOVE together with
 * the follow-up PR that implements — or declines — the standalone-only layout
 * change.
 *
 * Why this exists: a standalone iOS web app is a different display surface from
 * a Safari tab. It has no browser chrome, it honours
 * `apple-mobile-web-app-status-bar-style`, and it reports a real
 * `env(safe-area-inset-top)`. None of that is reproducible in a desktop browser
 * at a phone-sized viewport, where the inset is always 0 — so browser
 * measurements can neither confirm nor refute a standalone-only report.
 *
 * The build SHA is the important field: an installed PWA can serve a cached
 * shell indefinitely, so a measurement means nothing without the commit that
 * produced it.
 *
 * AUDIENCE: this panel covers most of the screen. Automatic display in
 * standalone is restricted to a single allowlisted account so reps and managers
 * never receive a debug overlay. It FAILS CLOSED — if no id is configured, the
 * standalone path is disabled entirely and only the explicit `?fkdiag` query
 * parameter can open it.
 */

const BUILD_SHA = import.meta.env.VITE_FK_BUILD_SHA || 'unknown';
const BUILD_TIME = import.meta.env.VITE_FK_BUILD_TIME || 'unknown';

/**
 * The one account that sees the panel automatically in standalone.
 * Set VITE_FK_DIAG_USER_ID at build time. Empty means nobody — deliberately.
 */
const DIAGNOSTIC_USER_ID = import.meta.env.VITE_FK_DIAG_USER_ID || '';

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

/** Enough to confirm identity without printing a full account id into a report. */
function maskId(id) {
  const value = String(id || '');
  if (!value) return 'none';
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

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
 * served. Refreshed alongside the layout numbers, because a worker can take
 * control after the first render — which is precisely the case that would
 * otherwise be missed.
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

export default function StandaloneDiagnostics({ user = null }) {
    const [data, setData] = React.useState(null);
    const [workerData, setWorkerData] = React.useState(null);
    const [dismissed, setDismissed] = React.useState(false);
    const [copyState, setCopyState] = React.useState('idle'); // idle | copied | failed
    const [fallbackText, setFallbackText] = React.useState('');
    const sequenceRef = React.useRef(0);
    const fallbackRef = React.useRef(null);

    const activation = React.useMemo(() => {
        if (typeof window === 'undefined') {
            return { show: false, forced: false, standalone: false, allowlisted: false, reason: 'ssr' };
        }
        const forced = new URLSearchParams(window.location.search).has('fkdiag');
        const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
            || window.navigator.standalone === true;
        // Fails closed: with no configured id, standalone never auto-opens.
        const allowlisted = Boolean(DIAGNOSTIC_USER_ID) && user?.id === DIAGNOSTIC_USER_ID;
        const show = forced || (standalone && allowlisted);
        return {
            show,
            forced,
            standalone,
            allowlisted,
            reason: forced ? 'forced' : show ? 'standalone-allowlisted' : 'hidden',
        };
    }, [user?.id]);

    React.useEffect(() => {
        if (!activation.show) return undefined;
        try {
            if (localStorage.getItem(DISMISS_KEY) === BUILD_SHA) setDismissed(true);
        } catch { /* storage unavailable — just show it */ }

        // One refresh for layout AND worker state. The sequence guard stops a
        // slow worker lookup from overwriting a newer sample.
        const refresh = async () => {
            const sequence = sequenceRef.current + 1;
            sequenceRef.current = sequence;
            setData(collectStandaloneDiagnostics());
            const worker = await collectWorkerDiagnostics();
            if (sequenceRef.current === sequence) setWorkerData(worker);
        };
        const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };

        // Measure after paint so the header has its final box, then again once
        // the status bar has settled.
        const frame = requestAnimationFrame(() => requestAnimationFrame(refresh));
        const settle = setTimeout(refresh, 500);
        window.addEventListener('resize', refresh);
        window.addEventListener('pageshow', refresh);
        window.addEventListener('orientationchange', refresh);
        document.addEventListener('visibilitychange', onVisibility);
        window.visualViewport?.addEventListener('resize', refresh);
        navigator.serviceWorker?.addEventListener?.('controllerchange', refresh);

        return () => {
            sequenceRef.current += 1; // invalidate any in-flight worker lookup
            cancelAnimationFrame(frame);
            clearTimeout(settle);
            window.removeEventListener('resize', refresh);
            window.removeEventListener('pageshow', refresh);
            window.removeEventListener('orientationchange', refresh);
            document.removeEventListener('visibilitychange', onVisibility);
            window.visualViewport?.removeEventListener('resize', refresh);
            navigator.serviceWorker?.removeEventListener?.('controllerchange', refresh);
        };
    }, [activation.show]);

    // When the clipboard is unavailable the JSON is rendered instead, focused and
    // selected so it can be copied by hand.
    React.useEffect(() => {
        if (copyState !== 'failed' || !fallbackRef.current) return;
        fallbackRef.current.focus();
        fallbackRef.current.select();
    }, [copyState]);

    if (!activation.show || dismissed || !data) return null;

    const report = {
        ...data,
        diagnostic_allowlist_configured: Boolean(DIAGNOSTIC_USER_ID),
        diagnostic_account_match: activation.allowlisted,
        diagnostic_activation_reason: activation.reason,
        authenticated_user_id: maskId(user?.id),
        // Bootstrap only. VITE_FK_DIAG_USER_ID needs the full id, and this is how
        // it is read from your own authenticated session instead of being
        // committed to the repository. Revealed ONLY when the panel was opened
        // deliberately with ?fkdiag — never during automatic standalone
        // activation, where nobody asked to see it.
        ...(activation.forced ? { authenticated_user_id_full: String(user?.id || 'none') } : {}),
        ...(workerData || { service_worker_controller_url: 'collecting…' }),
    };

    const copy = async () => {
        const text = JSON.stringify(report, null, 2);
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(text);
            // Only claim success once the write actually resolved. Reporting
            // "copied" on a rejected write would leave the JSON uncaptured while
            // looking like it had been saved.
            setCopyState('copied');
            setTimeout(() => setCopyState('idle'), 1500);
        } catch {
            setCopyState('failed');
            setFallbackText(text);
        }
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
                        {copyState === 'copied' ? 'copied' : copyState === 'failed' ? 'select below' : 'copy'}
                    </button>
                    <button type="button" onClick={dismiss} className="rounded border border-white/25 px-2 py-1 text-white/70">
                        hide
                    </button>
                </span>
            </div>

            {copyState === 'failed' && (
                <textarea
                    ref={fallbackRef}
                    readOnly
                    value={fallbackText}
                    onFocus={(event) => event.target.select()}
                    className="mb-2 h-40 w-full rounded border border-[#39FF4A]/40 bg-black p-2 text-[10px] text-[#39FF4A]"
                />
            )}

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
