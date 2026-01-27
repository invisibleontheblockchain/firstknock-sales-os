import React, { useState } from 'react';
import { 
    Map, Upload, Users, List, Navigation, CheckCircle, 
    ChevronRight, ChevronDown, MapPin, Filter, Route,
    FileSpreadsheet, Zap, Target, Clock, Smartphone, Key, Rocket, Share2
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F'
};

function TutorialSection({ icon: Icon, title, children, defaultOpen = false }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    
    return (
        <div className="border border-[#333] rounded-xl overflow-hidden mb-4">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full p-4 flex items-center justify-between bg-[#151515] hover:bg-[#1a1a1a] transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: `${BRAND.gold}20` }}>
                        <Icon className="w-5 h-5" style={{ color: BRAND.gold }} />
                    </div>
                    <span className="font-bold text-white">{title}</span>
                </div>
                {isOpen ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
            </button>
            {isOpen && (
                <div className="p-4 bg-[#0A0A0A] border-t border-[#333]">
                    {children}
                </div>
            )}
        </div>
    );
}

function Step({ number, title, description }) {
    return (
        <div className="flex gap-3 mb-4">
            <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm" style={{ background: BRAND.gold, color: BRAND.voidBlack }}>
                {number}
            </div>
            <div>
                <h4 className="font-bold text-white text-sm">{title}</h4>
                <p className="text-gray-400 text-sm mt-1">{description}</p>
            </div>
        </div>
    );
}

export default function Tutorial() {
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me().catch(() => null) });
    const isManager = user?.app_role === 'manager';

    return (
        <div className="min-h-full bg-[#0A0A0A] p-4 pb-24 overflow-y-auto">
            <div className="max-w-2xl mx-auto">
                {/* Header */}
                <div className="text-center mb-8 pt-4">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: BRAND.gold }}>
                        <Navigation className="w-8 h-8" style={{ color: BRAND.voidBlack }} />
                    </div>
                    <h1 className="text-2xl font-bold text-white mb-2">FirstKnock Help</h1>
                    <p className="text-gray-400">{isManager ? 'Manager Guide' : 'Rep Guide'} • Learn the app in 5 minutes</p>
                </div>

                {/* Quick Start - Different for Manager vs Rep */}
                {isManager ? (
                    <div className="p-4 rounded-xl mb-6" style={{ background: `${BRAND.gold}15`, border: `1px solid ${BRAND.gold}40` }}>
                        <h3 className="font-bold mb-3 flex items-center gap-2" style={{ color: BRAND.gold }}>
                            <Rocket className="w-5 h-5" /> Manager Quick Start
                        </h3>
                        <ol className="text-sm text-gray-300 space-y-2">
                            <li>1. <strong>Add your reps</strong> on the Team page - share their join code!</li>
                            <li>2. <strong>Generate routes</strong> by entering a zip code in Route Generator</li>
                            <li>3. <strong>Assign routes</strong> to your reps from the Team page</li>
                            <li>4. <strong>Track progress</strong> - see who's knocking and their results</li>
                        </ol>
                    </div>
                ) : (
                    <div className="p-4 rounded-xl mb-6" style={{ background: `${BRAND.gold}15`, border: `1px solid ${BRAND.gold}40` }}>
                        <h3 className="font-bold mb-3 flex items-center gap-2" style={{ color: BRAND.gold }}>
                            <Zap className="w-5 h-5" /> Rep Quick Start
                        </h3>
                        <ol className="text-sm text-gray-300 space-y-2">
                            <li>1. <strong>Check your route</strong> - your manager assigns routes to you</li>
                            <li>2. <strong>Tap a house</strong> to see details and log your result</li>
                            <li>3. <strong>Mark outcomes</strong> - Sold, Callback, No Answer, Not Interested</li>
                            <li>4. <strong>Keep knocking!</strong> Your progress saves automatically</li>
                        </ol>
                    </div>
                )}

                {/* Team Code Section - Manager Only */}
                {isManager && (
                    <TutorialSection icon={Key} title="Team Codes & Adding Reps" defaultOpen={true}>
                        <div className="space-y-4">
                            <div className="p-3 rounded-lg bg-green-900/20 border border-green-900/50">
                                <p className="text-sm text-green-300">
                                    <strong>How Team Codes Work:</strong> When you created your account, a 4-digit team code was generated. Share this with your reps!
                                </p>
                            </div>
                            
                            <Step 
                                number="1" 
                                title="Find Your Team Code" 
                                description="Go to Team page → tap 'Codes' button. You'll see your active codes there."
                            />
                            <Step 
                                number="2" 
                                title="Share with Your Reps" 
                                description="Text or tell your reps the 4-digit code. They enter it when they first open the app."
                            />
                            <Step 
                                number="3" 
                                title="Reps Auto-Join Your Team" 
                                description="Once they enter the code, they appear on your Team page and you can assign routes to them."
                            />
                            
                            <div className="p-3 rounded-lg bg-blue-900/20 border border-blue-900/50 mt-4">
                                <p className="text-xs text-blue-300">
                                    <strong>Pro Tip:</strong> Create different codes for different teams or campaigns. You can deactivate codes anytime.
                                </p>
                            </div>
                        </div>
                        <div className="mt-4">
                            <Link to={createPageUrl('AdminTeam')}>
                                <Button className="w-full" style={{ background: BRAND.gold, color: BRAND.voidBlack }}>
                                    <Users className="w-4 h-4 mr-2" /> Go to Team
                                </Button>
                            </Link>
                        </div>
                    </TutorialSection>
                )}

                {/* Tutorial Sections */}
                <TutorialSection icon={Upload} title="1. Setup & Data Upload" defaultOpen={true}>
                    <Step 
                        number="1" 
                        title="Go to Setup Page" 
                        description="Tap the 'Setup' icon in the bottom navigation bar."
                    />
                    <Step 
                        number="2" 
                        title="Upload Your CSV" 
                        description="Click 'Upload CSV/JSON' and select your property list file. The file should have columns like: address, city, state, zip, lat, lng."
                    />
                    <Step 
                        number="3" 
                        title="Set Your Territory" 
                        description="Use the Territory Filter to select which zip codes you want to work. This prevents the map from loading too much data at once."
                    />
                    <div className="mt-4">
                        <Link to={createPageUrl('Setup')}>
                            <Button className="w-full" style={{ background: BRAND.gold, color: BRAND.voidBlack }}>
                                <Upload className="w-4 h-4 mr-2" /> Go to Setup
                            </Button>
                        </Link>
                    </div>
                </TutorialSection>

                <TutorialSection icon={Map} title="2. Using the Map">
                    <Step 
                        number="1" 
                        title="View Your Properties" 
                        description="The map shows all properties in your territory. Gray dots = not visited, Green = sold, Red = rejected."
                    />
                    <Step 
                        number="2" 
                        title="Generate Routes" 
                        description="Tap the gold 'ROUTES' button at the bottom. The system will automatically create optimized walking routes."
                    />
                    <Step 
                        number="3" 
                        title="Filter & Customize" 
                        description="Use the FILTER button (top right) to adjust houses per route, set starting location, and filter by score."
                    />
                    <Step 
                        number="4" 
                        title="Switch Views" 
                        description="Toggle between Pin view and Heatmap view using the layer button to see hot areas."
                    />
                    <div className="mt-4">
                        <Link to={createPageUrl('Home')}>
                            <Button className="w-full" style={{ background: BRAND.gold, color: BRAND.voidBlack }}>
                                <Map className="w-4 h-4 mr-2" /> Go to Map
                            </Button>
                        </Link>
                    </div>
                </TutorialSection>

                <TutorialSection icon={Route} title="3. Working a Route">
                    <Step 
                        number="1" 
                        title="Select a Route" 
                        description="From the Routes panel, tap any route to activate it. The map will zoom to show that route."
                    />
                    <Step 
                        number="2" 
                        title="Open the Checklist" 
                        description="Tap 'CHECKLIST' to see all houses in order. This is your walking list."
                    />
                    <Step 
                        number="3" 
                        title="Log Results" 
                        description="After each door, tap the house and select the outcome: Sold, No Answer, Callback, or Hard No."
                    />
                    <Step 
                        number="4" 
                        title="Navigate" 
                        description="Tap 'Start Navigation' to open Apple/Google Maps with turn-by-turn directions."
                    />
                    <div className="p-3 rounded-lg bg-blue-900/20 border border-blue-900/50 mt-4">
                        <p className="text-xs text-blue-300">
                            <strong>Pro Tip:</strong> The system tracks your GPS location. Results are automatically stamped with your coordinates as proof of visit.
                        </p>
                    </div>
                </TutorialSection>

                <TutorialSection icon={List} title="4. List View">
                    <Step 
                        number="1" 
                        title="Browse All Data" 
                        description="The List page shows all your saved routes and properties in a scrollable format."
                    />
                    <Step 
                        number="2" 
                        title="Search & Filter" 
                        description="Use the search bar to find specific addresses or filter by status."
                    />
                    <Step 
                        number="3" 
                        title="Load Routes" 
                        description="Tap any saved route to load it on the map."
                    />
                </TutorialSection>

                {isManager && (
                    <TutorialSection icon={Users} title="5. Team Management">
                        <Step 
                            number="1" 
                            title="Share Your Team Code" 
                            description="Go to Team → Codes. Share the 4-digit code with your reps. They enter it when signing up."
                        />
                        <Step 
                            number="2" 
                            title="Generate Routes" 
                            description="Enter a zip code in the Team page search bar, then generate optimized routes for that area."
                        />
                        <Step 
                            number="3" 
                            title="Assign Routes to Reps" 
                            description="Each rep can be assigned multiple routes. They only see their own routes in the app."
                        />
                        <Step 
                            number="4" 
                            title="Track Progress" 
                            description="See real-time stats: doors knocked, sales, conversion rates for each rep."
                        />
                        <div className="p-3 rounded-lg bg-yellow-900/20 border border-yellow-900/50 mt-4">
                            <p className="text-xs text-yellow-300">
                                <strong>Scaling Your Team:</strong> Use the filters in Route Generator to control houses per route. Start with 50 houses/route for new reps, increase to 100+ for experienced ones.
                            </p>
                        </div>
                    </TutorialSection>
                )}

                {!isManager && (
                    <TutorialSection icon={Share2} title="5. Joining a Team">
                        <Step 
                            number="1" 
                            title="Get Your Code" 
                            description="Your manager will give you a 4-digit team code."
                        />
                        <Step 
                            number="2" 
                            title="Enter the Code" 
                            description="On the welcome screen, enter the code and tap JOIN."
                        />
                        <Step 
                            number="3" 
                            title="See Your Routes" 
                            description="Once joined, you'll see routes assigned to you by your manager."
                        />
                        <div className="p-3 rounded-lg bg-blue-900/20 border border-blue-900/50 mt-4">
                            <p className="text-xs text-blue-300">
                                <strong>No code yet?</strong> Ask your manager for the team code. They can find it on their Team → Codes page.
                            </p>
                        </div>
                    </TutorialSection>
                )}

                <TutorialSection icon={Target} title="6. Understanding Scores">
                    <div className="space-y-3 text-sm">
                        <div className="flex items-center justify-between p-2 rounded bg-[#151515]">
                            <span className="text-gray-300">Recently Sold (&lt;7 days)</span>
                            <span className="font-bold" style={{ color: BRAND.gold }}>+200 pts</span>
                        </div>
                        <div className="flex items-center justify-between p-2 rounded bg-[#151515]">
                            <span className="text-gray-300">Sold &lt;30 days</span>
                            <span className="font-bold" style={{ color: BRAND.gold }}>+180 pts</span>
                        </div>
                        <div className="flex items-center justify-between p-2 rounded bg-[#151515]">
                            <span className="text-gray-300">High Value Property</span>
                            <span className="font-bold text-green-500">+40 pts</span>
                        </div>
                        <div className="flex items-center justify-between p-2 rounded bg-[#151515]">
                            <span className="text-gray-300">Street on Cooldown</span>
                            <span className="font-bold text-red-500">Excluded</span>
                        </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-3">
                        Higher scores = better routes. The algorithm prioritizes recently sold homes and avoids streets you've already worked.
                    </p>
                </TutorialSection>

                {/* Status Legend */}
                <div className="p-4 rounded-xl border border-[#333] bg-[#151515] mb-6">
                    <h3 className="font-bold text-white mb-3 flex items-center gap-2">
                        <MapPin className="w-5 h-5" style={{ color: BRAND.gold }} />
                        Status Colors
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex items-center gap-2">
                            <div className="w-4 h-4 rounded-full bg-gray-500" />
                            <span className="text-sm text-gray-300">Not Visited</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-4 h-4 rounded-full bg-green-500" />
                            <span className="text-sm text-gray-300">Sold</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-4 h-4 rounded-full bg-red-500" />
                            <span className="text-sm text-gray-300">Hard No</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-4 h-4 rounded-full bg-yellow-500" />
                            <span className="text-sm text-gray-300">Callback</span>
                        </div>
                    </div>
                </div>

                {/* Why FirstKnock */}
                <div className="p-4 rounded-xl border border-[#333] bg-[#151515] mb-6">
                    <h3 className="font-bold text-white mb-3 flex items-center gap-2">
                        <Rocket className="w-5 h-5" style={{ color: BRAND.gold }} />
                        Why FirstKnock?
                    </h3>
                    <ul className="text-sm text-gray-400 space-y-2">
                        <li>✓ <strong className="text-white">Optimized Routes</strong> - AI-generated routes save hours of planning</li>
                        <li>✓ <strong className="text-white">Real-Time Tracking</strong> - Managers see live progress</li>
                        <li>✓ <strong className="text-white">No More Spreadsheets</strong> - All data in one place</li>
                        <li>✓ <strong className="text-white">Team Sync</strong> - Everyone stays on the same page</li>
                        <li>✓ <strong className="text-white">GPS Verification</strong> - Proof of visits for accountability</li>
                    </ul>
                </div>

                {/* Help */}
                <div className="text-center text-gray-500 text-sm">
                    <p>Need more help? Contact your team admin or email support.</p>
                </div>
            </div>
        </div>
    );
}