import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Map, Navigation, Users } from 'lucide-react';

export default function About() {
    return (
        <div className="min-h-full overflow-y-auto bg-[#0A0A0F] text-white px-5 py-10">
            <div className="max-w-4xl mx-auto space-y-10">
                <section className="glass-card rounded-3xl p-8 md:p-12">
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A29BFE] mb-6">
                        <Map className="w-4 h-4" /> Built for smarter field sales
                    </div>
                    <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-6">About FirstKnock</h1>
                    <div className="space-y-5 text-[#C7C7D8] text-lg leading-8">
                        <p>
                            FirstKnock is a door-to-door sales operating system built to help sales teams find better neighborhoods, create smarter routes, and manage field activity from one place. The app combines property data, recent home sale signals, route optimization, team assignment tools, appointment tracking, and rep-friendly mobile workflows so managers and sales representatives can spend less time guessing where to knock and more time having quality conversations.
                        </p>
                        <p>
                            FirstKnock is designed for canvassing teams, solar sales organizations, roofing companies, HVAC teams, home service providers, insurance teams, telecom groups, and any business that depends on efficient neighborhood outreach. Managers can plan territories, monitor team progress, assign routes, and review performance, while representatives can follow optimized routes, log results, capture visit notes, and stay focused in the field.
                        </p>
                        <p>
                            The product is built by a team focused on making field sales more practical, data-driven, and scalable. Instead of forcing teams to juggle spreadsheets, generic maps, disconnected CRMs, and manual territory planning, FirstKnock brings those workflows together into a simple sales platform made specifically for local market execution and repeatable canvassing growth.
                        </p>
                    </div>
                    <div className="grid md:grid-cols-3 gap-4 mt-10">
                        <Feature icon={Navigation} title="Route planning" text="Build cleaner routes from property and territory data." />
                        <Feature icon={Users} title="Team workflows" text="Assign reps, track progress, and manage field activity." />
                        <Feature icon={Map} title="Market focus" text="Turn territory data into practical daily knocking plans." />
                    </div>
                    <Link to="/Contact" className="inline-flex items-center gap-2 mt-10 text-[#A29BFE] font-bold hover:text-white transition-colors">
                        Contact us <ArrowRight className="w-4 h-4" />
                    </Link>
                </section>
            </div>
        </div>
    );
}

function Feature({ icon: Icon, title, text }) {
    return (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
            <Icon className="w-6 h-6 text-[#A29BFE] mb-4" />
            <h2 className="text-lg font-bold mb-2">{title}</h2>
            <p className="text-sm text-[#8888A0] leading-6">{text}</p>
        </div>
    );
}