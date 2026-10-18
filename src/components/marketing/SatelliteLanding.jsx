import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getLandingDestinations } from '@/lib/landingNavigation';
import { startSatelliteScene } from './satelliteScene';
import { HERO_AVIF_SRCSET, HERO_JPEG_SRC, HERO_PLACEHOLDER, HERO_SIZES, HERO_WEBP_SRCSET } from './heroImage';
import './SatelliteLanding.css';

const CONTACT_URL = 'https://calendly.com/firstknockhelp/30min';

export default function SatelliteLanding() {
  const rootRef = React.useRef(null);
  const { search } = useLocation();
  const { appEntry, signInUrl } = getLandingDestinations({
    search,
  });

  React.useEffect(() => startSatelliteScene(rootRef.current), []);

  return <main className="fk-satellite" ref={rootRef} aria-label="FirstKnock">

<div id="stage">
  {/* The house photo loads first; the scene gives these their src (data-src) once it is in. */}
  <div className="layer" id="lState"><img id="state" alt="" data-src="/landing/satellite-state.jpg" decoding="async" /></div>
  <div className="layer" id="lMetro"><img id="metro" alt="" data-src="/landing/satellite-metro.jpg" decoding="async" /></div>
  <div className="layer" id="lRegion"><img id="region" alt="" data-src="/landing/satellite-region.jpg" decoding="async" /></div>
  <div className="layer" id="lWide"><img alt="" data-src="/landing/satellite-zoom-roof-consistent.jpg" decoding="async" /></div>
  <div className="layer" id="lTight">
    {/* The hero photo on a camera: it pushes toward the door and tilts up into the sky above it (skyTransition.js). */}
    <div id="heroCam">
      <div className="hero-sky"></div>
      <div className="hero-placeholder" id="housePlaceholder" style={{ backgroundImage: HERO_PLACEHOLDER }}></div>
      <picture>
        <source type="image/avif" srcSet={HERO_AVIF_SRCSET} sizes={HERO_SIZES} />
        <source type="image/webp" srcSet={HERO_WEBP_SRCSET} sizes={HERO_SIZES} />
        {/* eslint-disable-next-line react/no-unknown-property -- React 18 passes the lowercase attribute through; 19 names it fetchPriority */}
        <img id="housePhoto" alt="" src={HERO_JPEG_SRC} fetchpriority="high" decoding="async" />
      </picture>
      <div className="hero-feather" id="heroFeather"></div>
    </div>
    <video id="fly" muted playsInline preload="auto"></video>
    {/* The flyover's first settled aerial frame: the ground the clouds part onto until the video is there (skyTransition.js). */}
    <picture>
      <source type="image/avif" data-srcset="/landing/flyover-roof-consistent-3500ms.avif" />
      <img id="flyAerial" alt="" data-src="/landing/flyover-roof-consistent-3500ms.webp" decoding="async" />
    </picture>
    <img id="sat" alt="" data-src="/landing/satellite-roof-consistent.jpg" decoding="async" />
  </div>
  {/* Clouds between the hero and the aerial, drawn in code: the house changes only while they cover the screen (skyTransition.js). */}
  <div id="clouds" aria-hidden="true">
    <div className="bank"></div>
    <div className="fog-day"></div>
    <div className="ring"></div>
    <div className="puff"></div>
    <div className="puff"></div>
    <div className="puff"></div>
  </div>
  <div className="layer" id="lHouse"><img alt="" data-src="/landing/satellite-roof-consistent.jpg" decoding="async" /></div>
  <svg className="layer" id="ov" viewBox="0 0 2688 1520"></svg>
</div>
<div className="shade" id="shadeL"></div><div className="shade" id="shadeB"></div>

<nav>
  <a className="brand" href="/"><img src="https://media.base44.com/images/public/695eb764b077190880be21de/147abd69b_image.png" alt="" />FirstKnock</a>
  <span className="sp"></span>
  <Link className="btn ghost small" to={signInUrl}>Sign in</Link>
</nav>
<div className="steps" id="steps"><i></i><i></i><i></i><i></i><i></i><i></i></div>

<section className="hero">
  <div className="col">
    <div className="kicker"><i></i>FirstKnock · Your D2D sales ecosystem</div>
    <h1><span className="ln">Stop pounding pavement.</span><span className="ln glow">Start driving to opportunities.</span></h1>
    <p className="lede">Verified new homeowners, optimized into one efficient driving route.</p>
    <div className="cta">
      <Link className="btn primary" to={appEntry}>Launch FirstKnock &#8599;</Link>
      <a className="btn ghost" href={CONTACT_URL} target="_blank" rel="noopener noreferrer" aria-label="Contact FirstKnock (opens in a new tab)">Contact us <span aria-hidden="true">&#8599;</span></a>
    </div>
  </div>
</section>
<section className="right">
  <div className="col">
    <div className="eyebrow">01 · The homeowner</div>
    <h2>It starts with<br /><span className="glow">one front door.</span></h2>
    <p className="lede">Every lead is a verified new homeowner, so your first knock lands at the right house at the right moment.</p>
  </div>
</section>
<section>
  <div className="col">
    <div className="eyebrow">02 · The territory</div>
    <h2>Draw your territory.<br /><span className="glow">See every home inside.</span></h2>
    <p className="lede">Trace any area, from a single street to a whole side of town. FirstKnock counts every home inside it in seconds.</p>
  </div>
</section>
<section>
  <div className="col">
    <div className="eyebrow">03 · The opportunities</div>
    <h2>Opportunities,<br /><span className="glow">not guesswork.</span></h2>
    <p className="lede">Verified new homeowners light up across your territory, right on the homes worth your time.</p>
  </div>
</section>
<section>
  <div className="col">
    <div className="eyebrow">04 · The route</div>
    <h2>One efficient<br /><span className="glow">driving route.</span></h2>
    <p className="lede">Precision orders every opportunity into a single optimized route, so the day goes to knocking, not driving in circles.</p>
    <div className="stats"><div className="stat"><b id="nstops">60</b><span>Opportunities</span></div><div className="stat"><b>1</b><span>Route</span></div><div className="stat"><b>0</b><span>Guesswork</span></div></div>
  </div>
</section>
<section>
  <div className="col">
    <div className="eyebrow">05 · The team</div>
    <h2>Split it across<br /><span className="glow">the whole team.</span></h2>
    <p className="lede">Canvas divides that route into fair, connected territories, one per rep, with every stop assigned and accounted for.</p>
  </div>
</section>
<section className="center">
  <div className="col">
    <div className="eyebrow">Your D2D sales ecosystem</div>
    <h2 className="final-title">Start driving to<br /><span className="glow">opportunities.</span></h2>
    <div className="cta">
      <Link className="btn primary" to={appEntry}>Launch FirstKnock &#8599;</Link>
      <a className="btn ghost" href={CONTACT_URL} target="_blank" rel="noopener noreferrer" aria-label="Contact FirstKnock (opens in a new tab)">Contact us <span aria-hidden="true">&#8599;</span></a>
    </div>
  </div>
</section>

<div className="legend" id="legend">
  <div className="lg-h">Today's team routes</div>
  <div id="lgRows"></div>
  <div className="lg-f"><span id="lgTotal"></span><b>&#10003; All assigned</b></div>
</div>
<div className="hint" id="hint">Scroll to explore</div>



  </main>;
}
