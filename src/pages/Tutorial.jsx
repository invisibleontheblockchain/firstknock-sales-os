import React, { useState } from 'react';
import { 
    Map, Upload, Users, Navigation, ChevronRight, ChevronDown, MapPin, 
    Route, FileSpreadsheet, Zap, Target, BarChart3, ArrowRight, SlidersHorizontal
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import ThemeColorPicker from '@/components/theme/ThemeColorPicker';

function Section({ icon: Icon, title, children, defaultOpen = false, accent }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="bg-[#111] border border-gray-800 rounded-xl overflow-hidden transition-all hover:border-gray-700">
            <button onClick={() => setIsOpen(!isOpen)} className="w-full p-4 flex items-center justify-between bg-gradient-to-r from-[#151515] to-[#0A0A0A] hover:from-[#1a1a1a] hover:to-[#111] transition-all">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center border" style={{ background: `${accent}15`, borderColor: `${accent}30`, color: accent }}>
                        <Icon className="w-4 h-4" />
                    </div>
                    <span className="font-bold text-white text-sm">{title}</span>
                </div>
                {isOpen ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
            </button>
            {isOpen && <div className="p-4 bg-black/50 border-t border-gray-800 animate-in slide-in-from-top-2">{children}</div>}
        </div>
    );
}

function Step({ number, title, description, accent }) {
    return (
        <div className="flex gap-3 mb-3">
            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-xs" style={{ background: accent, color: contrastText(accent) }}>{number}</div>
            <div>
                <h4 className="font-bold text-white text-sm">{title}</h4>
                <p className="text-gray-400 text-xs mt-0.5">{description}</p>
            </div>
        </div>
    );
}

export default function Tutorial() {
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);

    return (
        <div className="h-full overflow-y-auto bg-black text-white p-4 sm:p-6">
            <div className="max-w-2xl mx-auto space-y-6 pb-24">

                {/* Hero */}
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto" style={{ background: accent, boxShadow: `0 0 30px ${accent}40` }}>
                        <Navigation className="w-7 h-7" style={{ color: accentTxt }} />
                    </div>
                    <h1 className="text-2xl font-extrabold tracking-tight">How FirstKnock Works</h1>
                    <p className="text-gray-400 text-sm">Find the best houses in any zip code in 3 steps.</p>
                </div>

                {/* Quick Start — The Main Goal */}
                <div className="rounded-2xl p-5 border" style={{ background: `${accent}08`, borderColor: `${accent}25` }}>
                    <h3 className="font-bold mb-4 flex items-center gap-2 text-base" style={{ color: accent }}>
                        <Target className="w-5 h-5" /> Your Goal: Best Houses, Fastest Path
                    </h3>
                    <div className="space-y-3">
                        <div className="flex gap-3 items-start p-3 bg-black/40 rounded-lg border" style={{ borderColor: `${accent}15` }}>
                            <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs" style={{ background: accent, color: accentTxt }}>1</span>
                            <div>
                                <p className="text-sm text-white font-semibold">Enter Your Zip Code</p>
                                <p className="text-xs text-gray-400">We pull every property and score them by recent sales, equity, and value.</p>
                            </div>
                        </div>
                        <div className="flex gap-3 items-start p-3 bg-black/40 rounded-lg border" style={{ borderColor: `${accent}15` }}>
                            <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs" style={{ background: accent, color: accentTxt }}>2</span>
                            <div>
                                <p className="text-sm text-white font-semibold">Auto-Generated Routes</p>
                                <p className="text-xs text-gray-400">AI builds optimized walking paths hitting the highest-value doors first.</p>
                            </div>
                        </div>
                        <div className="flex gap-3 items-start p-3 bg-black/40 rounded-lg border" style={{ borderColor: `${accent}15` }}>
                            <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs" style={{ background: accent, color: accentTxt }}>3</span>
                            <div>
                                <p className="text-sm text-white font-semibold">Knock, Log, Repeat</p>
                                <p className="text-xs text-gray-400">Track every door. The system learns and improves your routes over time.</p>
                            </div>
                        </div>
                    </div>
                    <Link to={createPageUrl('Setup')}>
                        <Button className="w-full mt-4 h-10 font-bold" style={{ background: accent, color: accentTxt }}>
                            <ArrowRight className="w-4 h-4 mr-2" /> Start Setup Now
                        </Button>
                    </Link>
                </div>

                {/* Detailed Sections */}
                <Section icon={Upload} title="Setup & Territory" defaultOpen={false} accent={accent}>
                    <Step number="1" title="Go to Setup" description="The wizard auto-launches for new managers, or tap the Setup tab." accent={accent} />
                    <Step number="2" title="Enter Zip Codes" description="We pull properties, owners, and equity data live from a nationwide database." accent={accent} />
                    <Step number="3" title="Set Route Size" description="Choose how many homes per route (50 for evenings, 100+ for full days)." accent={accent} />
                    <Link to={createPageUrl('Setup')}><Button className="w-full mt-2 h-9 text-sm font-bold" style={{ background: accent, color: accentTxt }}><Upload className="w-4 h-4 mr-2" /> Go to Setup</Button></Link>
                </Section>

                <Section icon={Map} title="Using the Map" accent={accent}>
                    <Step number="1" title="View Properties" description="Every property appears as a color-coded pin. Gray = unvisited, Green = sold." accent={accent} />
                    <Step number="2" title="Generate Routes" description="Tap the gold ROUTES button. AI creates optimized walking paths automatically." accent={accent} />
                    <Step number="3" title="Filter & Customize" description="Adjust houses per route, starting location, score threshold, and more." accent={accent} />
                    <Link to={createPageUrl('Home')}><Button className="w-full mt-2 h-9 text-sm font-bold" style={{ background: accent, color: accentTxt }}><Map className="w-4 h-4 mr-2" /> Open Map</Button></Link>
                </Section>

                <Section icon={Route} title="Working a Route" accent={accent}>
                    <Step number="1" title="Activate a Route" description="Select any route from the panel. The map zooms to show those properties." accent={accent} />
                    <Step number="2" title="Use the Checklist" description="Tap CHECKLIST for the walking order. Each house has quick-log buttons." accent={accent} />
                    <Step number="3" title="Log Results" description="After each door: Sold, No Answer, Callback, or Hard No. GPS-stamped automatically." accent={accent} />
                    <div className="p-3 rounded-lg bg-blue-900/20 border border-blue-900/50 mt-3">
                        <p className="text-[11px] text-blue-300"><strong>Pro Tip:</strong> GPS coordinates are recorded as proof-of-visit with every log.</p>
                    </div>
                </Section>

                <Section icon={SlidersHorizontal} title="Route Builder Settings" accent={accent}>
                    <div className="space-y-4">
                        <div>
                            <h4 className="font-bold text-white text-sm mb-2">Walking Patterns</h4>
                            <ul className="space-y-2 text-xs text-gray-400">
                                <li className="flex gap-2"><span className="text-white font-bold">Street Sweep:</span> Mailman style. Hits one side of the street, then loops back for the other. Best for density.</li>
                                <li className="flex gap-2"><span className="text-white font-bold">Nearest Door:</span> Always goes to the physically closest next house. Good for scattered leads.</li>
                                <li className="flex gap-2"><span className="text-white font-bold">Zig-Zag:</span> Crosses the street back and forth. Best for short streets.</li>
                                <li className="flex gap-2"><span className="text-white font-bold">Cluster Hop:</span> Prioritizes dense pockets of homes first, then expands outward. Great for efficient knocking.</li>
                            </ul>
                        </div>
                        <div>
                            <h4 className="font-bold text-white text-sm mb-2">Optimization Tools</h4>
                            <ul className="space-y-2 text-xs text-gray-400">
                                <li className="flex gap-2"><span className="text-white font-bold">Minimize Turns:</span> Tries to keep you on straight paths to avoid disorientation.</li>
                                <li className="flex gap-2"><span className="text-white font-bold">Path Smoothing (2-Opt):</span> Advanced algorithm that untangles crossing paths to reduce total walking distance.</li>
                                <li className="flex gap-2"><span className="text-white font-bold">Loop Back:</span> Ensures your route ends close to where you started (your car).</li>
                            </ul>
                        </div>
                    </div>
                </Section>

                <Section icon={BarChart3} title="Understanding Scores" accent={accent}>
                    <div className="space-y-2 text-sm">
                        {[
                            ['Recently Sold (<7 days)', '+200 pts', accent],
                            ['Sold <30 days', '+180 pts', accent],
                            ['High Value Property', '+40 pts', '#10B981'],
                            ['Street on Cooldown', 'Excluded', '#EF4444'],
                        ].map(([label, pts, color]) => (
                            <div key={label} className="flex items-center justify-between p-2 rounded bg-[#151515]">
                                <span className="text-gray-300 text-xs">{label}</span>
                                <span className="font-bold text-xs" style={{ color }}>{pts}</span>
                            </div>
                        ))}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-2">Higher scores = better routes. Recently sold homes and high-equity properties are prioritized.</p>
                </Section>

                <Section icon={Users} title="Team Management" accent={accent}>
                    <Step number="1" title="Add Reps" description="Go to Team and invite reps with a PIN code." accent={accent} />
                    <Step number="2" title="Assign Routes" description="Dispatch routes to specific reps. They only see their assigned work." accent={accent} />
                    <Step number="3" title="Track Performance" description="View completion stats, houses knocked, and leaderboard rankings." accent={accent} />
                </Section>

                {/* Theme Picker */}
                <div className="p-4 rounded-xl border border-gray-800 bg-[#111]">
                    <ThemeColorPicker />
                </div>

                {/* Status Legend */}
                <div className="p-4 rounded-xl border border-gray-800 bg-[#151515]">
                    <h3 className="font-bold text-white mb-3 flex items-center gap-2 text-sm">
                        <MapPin className="w-4 h-4" style={{ color: accent }} /> Pin Colors
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                        {[['#6B7280', 'Not Visited'], ['#10B981', 'Sold'], ['#EF4444', 'Hard No'], [accent, 'Callback']].map(([c, l]) => (
                            <div key={l} className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ background: c }} />
                                <span className="text-xs text-gray-300">{l}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Legal */}
                <div className="pt-6 border-t border-gray-800">
                    <div className="flex flex-col gap-2 items-start">
                        <Link to={createPageUrl('Terms')} className="text-gray-400 hover:text-white flex items-center gap-2 text-xs"><FileSpreadsheet className="w-3 h-3" /> Terms of Service</Link>
                        <Link to={createPageUrl('DeleteAccount')} className="text-red-500 hover:text-red-400 flex items-center gap-2 text-xs"><Zap className="w-3 h-3" /> Delete Account</Link>
                    </div>
                    <p className="text-center text-gray-600 text-[10px] mt-6">Need help? Email support@firstknock.app</p>
                </div>
            </div>
        </div>
    );
}