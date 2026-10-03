import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getLandingDestinations } from '@/lib/landingNavigation';
import { startSatelliteScene } from './satelliteScene';
import './SatelliteLanding.css';

export default function SatelliteLanding() {
  const rootRef = React.useRef(null);
  const { search } = useLocation();
  const { appEntry, signInUrl } = getLandingDestinations({
    search,
  });

  React.useEffect(() => startSatelliteScene(rootRef.current), []);

  return <main className="fk-satellite" ref={rootRef} aria-label="FirstKnock">

<div id="stage">
  <div className="layer" id="lState"><img id="state" alt="" src="/landing/satellite-state.jpg" /></div>
  <div className="layer" id="lMetro"><img id="metro" alt="" src="/landing/satellite-metro.jpg" /></div>
  <div className="layer" id="lRegion"><img id="region" alt="" src="/landing/satellite-region.jpg" /></div>
  <div className="layer" id="lWide"><img alt="" src="/landing/satellite-zoom-lux.jpg" /></div>
  <div className="layer" id="lTight">
    <video id="fly" muted playsInline preload="auto" poster="/landing/house-lux.jpg"></video>
    <img id="sat" alt="" src="/landing/satellite-lux.jpg" />
  </div>
  <svg className="layer" id="ov" viewBox="0 0 2688 1520"></svg>
</div>
<div className="shade" id="shadeL"></div><div className="shade" id="shadeB"></div>

<nav>
  <a className="brand" href="/"><img src="https://media.base44.com/images/public/695eb764b077190880be21de/147abd69b_image.png" alt="" />FirstKnock</a>
  <span className="sp"></span>
  <Link className="link" to={signInUrl}>Sign in</Link>
  <Link className="btn primary small" to={appEntry}>Launch FirstKnock &#8599;</Link>
</nav>
<div className="steps" id="steps"><i></i><i></i><i></i><i></i><i></i><i></i></div>

<section className="hero">
  <div className="col">
    <div className="kicker"><i></i>FirstKnock · Your D2D sales ecosystem</div>
    <h1><span className="ln">Stop pounding pavement.</span><span className="ln glow">Start driving to opportunities.</span></h1>
    <p className="lede">Verified new homeowners, optimized into one efficient driving route.</p>
    <div className="cta"><Link className="btn primary" to={appEntry}>Launch FirstKnock &#8599;</Link><Link className="btn ghost" to={signInUrl}>Sign in</Link></div>
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
    <div className="cta"><Link className="btn primary" to={appEntry}>Launch FirstKnock &#8599;</Link><Link className="btn ghost" to={signInUrl}>Sign in</Link></div>
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
