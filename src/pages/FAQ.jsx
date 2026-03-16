import React, { useState } from 'react';
import { 
    HelpCircle, ChevronRight, ChevronDown, Map, Users, 
    CreditCard, Zap, AlertCircle, FileSpreadsheet, 
    Target, LineChart, ShieldAlert, MessageSquare,
    Search, MousePointer2, Settings, Rocket
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

function FAQSection({ icon: Icon, title, children, defaultOpen = false }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="bg-[#111] border border-gray-800 rounded-xl overflow-hidden transition-all hover:border-gray-700">
            <button onClick={() => setIsOpen(!isOpen)} className="w-full p-4 flex items-center justify-between bg-black hover:bg-[#151515] transition-all">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-yellow-500/10 border border-yellow-500/20 text-yellow-500">
                        <Icon className="w-4 h-4" />
                    </div>
                    <span className="font-bold text-white text-sm">{title}</span>
                </div>
                {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
            </button>
            {isOpen && <div className="p-4 bg-black/40 border-t border-gray-800 animate-in slide-in-from-top-2">{children}</div>}
        </div>
    );
}

function Question({ q, a }) {
    return (
        <div className="mb-6 last:mb-0">
            <h4 className="text-white font-bold text-sm mb-2 flex items-start gap-2">
                <span className="text-yellow-500 mt-0.5">Q:</span> {q}
            </h4>
            <div className="text-gray-400 text-xs leading-relaxed pl-6 border-l border-gray-800">
                {a}
            </div>
        </div>
    );
}

export default function FAQ() {
    return (
        <div className="h-full overflow-y-auto bg-black text-white p-4 sm:p-8">
            <div className="max-w-3xl mx-auto space-y-6 pb-24">

                {/* Hero */}
                <div className="text-center space-y-3 py-6">
                    <div className="w-16 h-16 rounded-2xl bg-yellow-500 flex items-center justify-center mx-auto shadow-lg shadow-yellow-500/20">
                        <HelpCircle className="w-8 h-8 text-black" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight">Support & FAQ</h1>
                    <p className="text-gray-500 text-sm">Everything you need to know about FirstKnock.</p>
                </div>

                {/* Sections */}
                <FAQSection icon={Rocket} title="Getting Started" defaultOpen={true}>
                    <Question 
                        q="How do I set up my first territory?" 
                        a="Go to the Setup tab, enter the zip codes you want to work, and tap 'Fetch Data'. We'll pull active records for those areas immediately. Alternatively, use the 'Go Draw Territory' button on the map to manually select an area." 
                    />
                    <Question 
                        q="How do I invite my team?" 
                        a="In the Command Center, navigate to 'Admin & Team'. You can invite new reps by entering their email. They will receive an invitation to join your organization." 
                    />
                    <Question 
                        q="How do I draw a new area to generate?" 
                        a="Enter Builder mode on the map, click the 'Draw on Map' button (it turns gold), then click or tap on the map to place points. Surround your target area and click 'Confirm Area' to finish. The button will then switch to 'Generate Routes'." 
                    />
                </FAQSection>

                <FAQSection icon={CreditCard} title="Billing & Subscription">
                    <Question 
                        q="How do I set up billing?" 
                        a="Billing is managed in the 'Billing' section of the Command Center. You can add a payment method and choose a plan that fits your team size." 
                    />
                    <Question 
                        q="How do I cancel or pause my subscription?" 
                        a="You can manage your subscription status in the Billing tab. We offer monthly plans with no long-term contracts, so you can cancel or pause anytime if you're out of season." 
                    />
                </FAQSection>

                <FAQSection icon={FileSpreadsheet} title="Data & Imports">
                    <Question 
                        q="How do I import my CSV?" 
                        a="Go to the 'Setup' page, select the 'Import Data' tab, and drag your CSV file into the uploader. Our system auto-detects column headers for address, name, and status. If you have a custom format, you can map the columns manually." 
                    />
                    <Question 
                        q="Where did my houses go?" 
                        a="If you can't see houses, check your zoom level (pins often appear at zoom 13+). Also, ensure you haven't applied a 'Sold Date' filter that is too strict for your area." 
                    />
                </FAQSection>

                <FAQSection icon={Target} title="Route Builder & AI">
                    <Question 
                        q="What's the difference between route types?" 
                        a={
                            <ul className="space-y-2">
                                <li><strong>Street Sweep:</strong> Optimized like a mail carrier route. Hits one side of the street, then loops back. Maximum efficiency.</li>
                                <li><strong>Nearest Door:</strong> A simple 'greedy' algorithm that always takes you to the next closest pin.</li>
                                <li><strong>Fisherman:</strong> An advanced strategy that prioritizes high-propensity 'strikes' first, even if they are slightly further apart.</li>
                            </ul>
                        }
                    />
                    <Question 
                        q="How do I use the AI coaching?" 
                        a="The AI coaching analyzes your pitch logs and closure rates to suggest improvements. You can view personalized 'Next Steps' for each rep in the Analytics dashboard." 
                    />
                    <Question 
                        q="What is the 'Propensity Score'?" 
                        a="It's a value from 0-100+ that indicates how likely a homeowner is to sell or engage. We use local market trends, sale history, and equity data to calculate this for every house." 
                    />
                </FAQSection>

                <FAQSection icon={ShieldAlert} title="Troubleshooting">
                    <Question 
                        q="The app is running slow" 
                        a="If the map feels laggy, try clearing your 'Preview Routes'. Large territories with 10k+ pins are automatically culled to keep performance high. Using 'Dark Mode' also helps with battery life on mobile." 
                    />
                    <Question 
                        q="I can't log in" 
                        a="Ensure you are using the same email address that your manager invited. If you are a manager, check that your subscription hasn't expired. Contact firstknockhelp@gmail.com if the issue persists." 
                    />
                    <Question 
                        q="How do I track my reps?" 
                        a="Live tracking is available in the 'Routes' mode for Managers. You can see real-time breadcrumbs of where your team has been and the status of the doors they've knocked." 
                    />
                </FAQSection>

                {/* Contact CTA */}
                <div className="p-8 rounded-2xl bg-gradient-to-br from-[#111] to-[#050505] border border-gray-800 text-center">
                    <h3 className="text-xl font-bold mb-2">Still have questions?</h3>
                    <p className="text-gray-500 text-sm mb-6">Our team is here to help you dominate your territory.</p>
                    <div className="flex flex-col sm:flex-row gap-3 justify-center">
                        <Button className="bg-white text-black font-bold h-11 px-8 rounded-xl" onClick={() => window.location.href='mailto:firstknockhelp@gmail.com'}>
                            <MessageSquare className="w-4 h-4 mr-2" />
                            <span>Email Support</span>
                        </Button>
                        <Link to={createPageUrl('Home')}>
                            <Button variant="outline" className="border-gray-700 h-11 px-8 rounded-xl text-white">
                                <span>Back to Map</span>
                            </Button>
                        </Link>
                    </div>
                </div>

                <div className="text-center text-[10px] text-gray-700 uppercase tracking-[0.2em] pt-8">
                    FirstKnock Sales OS v4.2 &copy; 2026
                </div>
            </div>
        </div>
    );
}
