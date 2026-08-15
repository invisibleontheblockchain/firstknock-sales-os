import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Map,
  MapPinned,
  Navigation,
  Play,
  Route,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import {
  getAcquisitionIdentity,
  sendAcquisitionEvent,
} from '@/lib/acquisitionEvents';
import {
  isGenericAcquisitionContent,
  parseAcquisitionTouch,
  readStoredAcquisition,
  reportStoredAcquisitionContent,
} from '@/lib/acquisitionTracking';

const LOGO_URL = 'https://media.base44.com/images/public/695eb764b077190880be21de/147abd69b_image.png';

function ProductPreview() {
  const stops = [
    ['18%', '19%', '1'],
    ['35%', '28%', '2'],
    ['58%', '19%', '3'],
    ['75%', '34%', '4'],
    ['66%', '57%', '5'],
    ['43%', '66%', '6'],
    ['23%', '53%', '7'],
  ];

  return (
    <div className="relative mx-auto w-full max-w-[620px]">
      <div className="absolute -inset-8 rounded-[3rem] bg-[#2EEB57]/10 blur-3xl" />
      <div className="relative overflow-hidden rounded-[1.75rem] border border-white/15 bg-[#080b09] shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#2EEB57] shadow-[0_0_12px_rgba(46,235,87,0.9)]" />
            <span className="text-xs font-bold text-white/70">Demo territory</span>
          </div>
          <span className="rounded-full border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-[#8cff9f]">
            Ready to assign
          </span>
        </div>

        <div className="grid sm:grid-cols-[1fr_180px]">
          <div
            className="relative min-h-[310px] overflow-hidden border-b border-white/10 sm:min-h-[390px] sm:border-b-0 sm:border-r"
            style={{
              backgroundColor: '#101512',
              backgroundImage: `
                linear-gradient(32deg, transparent 47%, rgba(255,255,255,0.055) 48%, rgba(255,255,255,0.055) 50%, transparent 51%),
                linear-gradient(118deg, transparent 46%, rgba(255,255,255,0.045) 47%, rgba(255,255,255,0.045) 49%, transparent 50%),
                linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)
              `,
              backgroundSize: '140px 140px, 190px 190px, 28px 28px, 28px 28px',
            }}
          >
            <div className="absolute left-[9%] top-[11%] h-[72%] w-[79%] rotate-[-3deg] rounded-[32%_22%_28%_18%] border border-[#2EEB57]/35 bg-[#2EEB57]/[0.04]" />
            <div className="absolute left-[17%] top-[20%] h-1 w-[22%] rotate-[24deg] rounded-full bg-[#2EEB57] shadow-[0_0_10px_rgba(46,235,87,0.65)]" />
            <div className="absolute left-[34%] top-[32%] h-1 w-[27%] rotate-[-17deg] rounded-full bg-[#2EEB57] shadow-[0_0_10px_rgba(46,235,87,0.65)]" />
            <div className="absolute left-[57%] top-[31%] h-1 w-[23%] rotate-[42deg] rounded-full bg-[#2EEB57] shadow-[0_0_10px_rgba(46,235,87,0.65)]" />
            <div className="absolute left-[64%] top-[54%] h-1 w-[16%] rotate-[105deg] rounded-full bg-[#2EEB57] shadow-[0_0_10px_rgba(46,235,87,0.65)]" />
            <div className="absolute left-[43%] top-[62%] h-1 w-[25%] rotate-[-8deg] rounded-full bg-[#2EEB57] shadow-[0_0_10px_rgba(46,235,87,0.65)]" />
            <div className="absolute left-[22%] top-[58%] h-1 w-[23%] rotate-[17deg] rounded-full bg-[#2EEB57] shadow-[0_0_10px_rgba(46,235,87,0.65)]" />

            {stops.map(([left, top, label]) => (
              <div
                key={label}
                className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-black bg-[#2EEB57] text-[10px] font-black text-black shadow-[0_0_18px_rgba(46,235,87,0.45)]"
                style={{ left, top }}
              >
                {label}
              </div>
            ))}

            <div className="absolute bottom-4 left-4 rounded-xl border border-white/10 bg-black/75 px-3 py-2 backdrop-blur">
              <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">Route 01</p>
              <p className="mt-0.5 text-sm font-black text-white">47 homes · 2.8 mi</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-px bg-white/10 sm:block">
            {[
              ['Routes', '3', Route],
              ['Homes', '142', MapPinned],
              ['Assigned', '0 / 3', UsersRound],
            ].map(([label, value, Icon]) => (
              <div key={label} className="bg-[#080b09] p-3 sm:border-b sm:border-white/10 sm:p-4">
                <Icon className="h-4 w-4 text-[#2EEB57]" />
                <p className="mt-3 text-xl font-black text-white">{value}</p>
                <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-white/35">{label}</p>
              </div>
            ))}
            <div className="hidden p-4 sm:block">
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/35">Next step</p>
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-[#2EEB57] px-3 py-2 text-xs font-black text-black">
                Assign team
                <ChevronRight className="h-3.5 w-3.5" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-[10px] text-white/30">Illustrative product preview</p>
    </div>
  );
}

function Step({ number, icon: Icon, title, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <div className="flex items-center justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2EEB57]/10 text-[#2EEB57]">
          <Icon className="h-5 w-5" />
        </div>
        <span className="font-mono text-xs font-bold text-white/25">0{number}</span>
      </div>
      <h3 className="mt-5 text-lg font-black text-white">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-white/50">{children}</p>
    </div>
  );
}

export default function InstagramLanding() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoadingAuth } = useAuth();
  const identityRef = React.useRef(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const [contentChoices, setContentChoices] = React.useState([]);
  const [contentChoiceState, setContentChoiceState] = React.useState('idle');
  const [selectedContent, setSelectedContent] = React.useState(null);
  const landingTouch = React.useMemo(() => parseAcquisitionTouch({
    href: window.location.href,
    referrer: document.referrer,
  }), []);
  const landingJourneyCapturedAt = React.useMemo(() => {
    const storedTouch = readStoredAcquisition()?.last_touch;
    if (
      !landingTouch
      || !storedTouch
      || storedTouch.source !== landingTouch.source
      || storedTouch.campaign !== landingTouch.campaign
      || storedTouch.content !== landingTouch.content
      || storedTouch.landing_path !== landingTouch.landing_path
    ) {
      return '';
    }
    return String(storedTouch.captured_at || '');
  }, [landingTouch]);

  if (!identityRef.current) {
    identityRef.current = getAcquisitionIdentity();
  }

  const track = React.useCallback((eventName, ctaVariant = '', eventOptions = {}) => (
    sendAcquisitionEvent(
      (functionName, payload) => base44.functions.invoke(functionName, payload),
      eventName,
      {
        ctaVariant,
        landingPath: window.location.pathname,
        identity: identityRef.current,
        ...eventOptions,
      },
    ).catch(() => null)
  ), []);

  React.useEffect(() => {
    const previousTitle = document.title;
    document.title = 'FirstKnock — Turn territory into assigned routes';
    void track('landing_viewed', '', {
      touchOverride: landingTouch,
      useStoredTouch: false,
    });
    return () => {
      document.title = previousTitle;
    };
  }, [landingTouch, track]);

  React.useEffect(() => {
    let canceled = false;
    if (isLoadingAuth) {
      setContentChoiceState('loading');
      return () => {
        canceled = true;
      };
    }
    if (
      isAuthenticated
      || !landingTouch
      || !landingJourneyCapturedAt
      || !['instagram', 'tiktok'].includes(landingTouch.source)
      || landingTouch.campaign !== '1000-users'
      || !isGenericAcquisitionContent(
        landingTouch.source,
        landingTouch.content,
      )
    ) {
      setContentChoiceState('not_applicable');
      return () => {
        canceled = true;
      };
    }

    setContentChoiceState('loading');
    base44.functions.invoke('getRecentGrowthContentChoices', {
      source: landingTouch.source,
      campaign: landingTouch.campaign,
      content: landingTouch.content,
      landing_path: window.location.pathname,
    }).then((response) => {
      if (canceled) return;
      const body = response?.data || response;
      const choices = Array.isArray(body?.choices) ? body.choices : [];
      setContentChoices(choices);
      setContentChoiceState(choices.length ? 'ready' : 'empty');
    }).catch(() => {
      if (!canceled) setContentChoiceState('unavailable');
    });

    return () => {
      canceled = true;
    };
  }, [
    isAuthenticated,
    isLoadingAuth,
    landingJourneyCapturedAt,
    landingTouch,
  ]);

  const reportContentAssist = (choice) => {
    if (!landingTouch || selectedContent) return;
    const result = reportStoredAcquisitionContent({
      platform: landingTouch.source,
      campaign: landingTouch.campaign,
      contentId: choice.content,
      expectedCapturedAt: landingJourneyCapturedAt,
    });
    if (result.status !== 'reported') return;
    setSelectedContent(choice);
    setContentChoiceState('reported');
    void track('content_assist_reported');
  };

  const startWorkspace = async (ctaVariant) => {
    if (isStarting) return;
    setIsStarting(true);
    await Promise.race([
      track(
        'signup_cta_clicked',
        ctaVariant,
        selectedContent
          ? {}
          : {
            touchOverride: landingTouch,
            useStoredTouch: false,
          },
      ),
      new Promise((resolve) => setTimeout(resolve, 700)),
    ]);

    if (isAuthenticated) {
      navigate('/RoleSelect');
      return;
    }

    try {
      base44.auth.redirectToLogin(
        new URL('/RoleSelect', window.location.origin).toString(),
      );
    } catch {
      setIsStarting(false);
    }
  };

  const ctaLabel = isAuthenticated
    ? 'Open FirstKnock'
    : isLoadingAuth
      ? 'Create your workspace'
      : 'Create your workspace';

  return (
    <div className="h-full overflow-y-auto bg-black text-white selection:bg-[#2EEB57] selection:text-black">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(circle_at_68%_22%,rgba(46,235,87,0.14),transparent_42%),radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.06),transparent_34%)]" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.18) 1px,transparent 1px)', backgroundSize: '42px 42px' }} />

        <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
          <a href="#top" className="flex items-center gap-3" aria-label="FirstKnock home">
            <img src={LOGO_URL} alt="" className="h-10 w-10 rounded-xl border border-white/10 object-cover" />
            <span className="text-lg font-black tracking-tight">FirstKnock</span>
          </a>
          <button
            type="button"
            onClick={() => startWorkspace('nav')}
            disabled={isStarting}
            className="rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 text-xs font-black text-white transition hover:border-[#2EEB57]/50 hover:bg-[#2EEB57]/10 disabled:opacity-60"
          >
            {isAuthenticated ? 'Open app' : 'Sign in'}
          </button>
        </header>

        <main id="top" className="relative z-10">
          <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-12 sm:px-8 sm:pt-20 lg:grid-cols-[0.92fr_1.08fr] lg:gap-16 lg:pb-28">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-[#8cff9f]">
                <Sparkles className="h-3.5 w-3.5" />
                Built for door-to-door teams
              </div>
              <h1 className="mt-6 max-w-2xl text-5xl font-black leading-[0.98] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
                Turn territory into{' '}
                <span className="text-[#2EEB57]">clean, assigned routes.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-white/55 sm:text-lg">
                Draw the area, turn homes into walkable routes, assign your reps, and keep the whole team on one live field map.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => startWorkspace('hero')}
                  disabled={isStarting}
                  className="inline-flex min-h-14 items-center justify-center rounded-xl bg-[#2EEB57] px-6 text-sm font-black text-black shadow-[0_0_30px_rgba(46,235,87,0.24)] transition hover:bg-[#55f875] disabled:cursor-wait disabled:opacity-70"
                >
                  {isStarting ? 'Opening FirstKnock…' : ctaLabel}
                  {!isStarting && <ArrowRight className="ml-2 h-4 w-4" />}
                </button>
                <a
                  href="#workflow"
                  className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] px-6 text-sm font-black text-white transition hover:bg-white/[0.08]"
                >
                  <Play className="mr-2 h-4 w-4 fill-current" />
                  See the workflow
                </a>
              </div>

              {contentChoiceState === 'ready' && !selectedContent && (
                <div className="mt-5 max-w-xl rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-black text-white">Which demo brought you here?</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                        Optional—one tap helps us learn which product walkthroughs are useful.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setContentChoiceState('dismissed')}
                      className="shrink-0 text-[10px] font-bold text-white/35 transition hover:text-white"
                    >
                      Not sure
                    </button>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {contentChoices.map((choice) => (
                      <button
                        key={choice.content}
                        type="button"
                        onClick={() => reportContentAssist(choice)}
                        className="rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-left text-[11px] font-bold leading-snug text-white/70 transition hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/10 hover:text-white"
                      >
                        {choice.hook || 'FirstKnock product demo'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {contentChoiceState === 'reported' && selectedContent && (
                <div className="mt-5 max-w-xl rounded-xl border border-[#2EEB57]/20 bg-[#2EEB57]/10 px-4 py-3 text-xs text-[#a5ffb4]">
                  Thanks—you selected “{selectedContent.hook || 'FirstKnock product demo'}.”
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold text-white/40">
                {['Manager-first workspace', 'Rep-ready routes', 'Mobile field view'].map((item) => (
                  <span key={item} className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-[#2EEB57]" />
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <ProductPreview />
          </section>

          <section id="workflow" className="border-y border-white/10 bg-[#050505]">
            <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24">
              <div className="max-w-2xl">
                <p className="text-xs font-black uppercase tracking-[0.2em] text-[#2EEB57]">From map to field</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
                  One manager. One map. No territory guesswork.
                </h2>
                <p className="mt-4 text-base leading-relaxed text-white/50">
                  FirstKnock gives managers a repeatable way to prepare the day and gives reps a clear route when they hit the field.
                </p>
              </div>

              <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Step number="1" icon={Map} title="Draw the territory">
                  Choose the exact area your team plans to work.
                </Step>
                <Step number="2" icon={Route} title="Build clean routes">
                  Turn eligible homes into organized, walkable route groups.
                </Step>
                <Step number="3" icon={UsersRound} title="Assign the team">
                  Give each rep a route without overlapping another rep.
                </Step>
                <Step number="4" icon={Navigation} title="Run the field day">
                  Let reps follow the route and log outcomes from their phone.
                </Step>
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.2em] text-[#2EEB57]">The operating layer</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">
                  Stop rebuilding the day in group chats.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-relaxed text-white/50">
                  Territory, assignments, route progress, and field outcomes stay connected in the same workspace.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  [ShieldCheck, 'Clear ownership', 'Managers can see which route belongs to which rep before the first knock.'],
                  [MapPinned, 'Field-ready context', 'Reps receive the route and property sequence in a mobile workflow.'],
                  [Route, 'Repeatable routing', 'Save the territory-to-route process instead of rebuilding it manually.'],
                  [UsersRound, 'Team visibility', 'Use one shared operating picture from assignment through outcomes.'],
                ].map(([Icon, title, copy]) => (
                  <div key={title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                    <Icon className="h-5 w-5 text-[#2EEB57]" />
                    <h3 className="mt-4 font-black">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-white/45">{copy}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="border-t border-white/10 px-5 py-20 sm:px-8">
            <div className="mx-auto max-w-4xl overflow-hidden rounded-[2rem] border border-[#2EEB57]/25 bg-[radial-gradient(circle_at_top,rgba(46,235,87,0.16),rgba(255,255,255,0.035)_58%)] px-6 py-12 text-center sm:px-12 sm:py-16">
              <p className="text-xs font-black uppercase tracking-[0.2em] text-[#8cff9f]">Build the first route</p>
              <h2 className="mx-auto mt-4 max-w-2xl text-3xl font-black tracking-tight sm:text-5xl">
                Give your next field day a clean starting point.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-white/50 sm:text-base">
                Create a manager workspace, define the territory, and take FirstKnock into the field with your team.
              </p>
              <button
                type="button"
                onClick={() => startWorkspace('final')}
                disabled={isStarting}
                className="mt-8 inline-flex min-h-14 items-center justify-center rounded-xl bg-[#2EEB57] px-7 text-sm font-black text-black transition hover:bg-[#55f875] disabled:opacity-70"
              >
                {isStarting ? 'Opening FirstKnock…' : ctaLabel}
                {!isStarting && <ArrowRight className="ml-2 h-4 w-4" />}
              </button>
            </div>
          </section>
        </main>

        <footer className="relative z-10 border-t border-white/10 px-5 py-6 sm:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} FirstKnock. Door-to-door territory and route operations.</p>
            <a className="transition hover:text-white" href="mailto:firstknockhelp@gmail.com">
              firstknockhelp@gmail.com
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
