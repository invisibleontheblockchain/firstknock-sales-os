import React from 'react';
import { Mail, MessageCircle, ArrowRight } from 'lucide-react';

export default function Contact() {
    return (
        <div className="min-h-full overflow-y-auto bg-[#0A0A0F] text-white px-5 py-10">
            <div className="max-w-3xl mx-auto">
                <section className="glass-card rounded-3xl p-8 md:p-12">
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A29BFE] mb-6">
                        <MessageCircle className="w-4 h-4" /> We would love to hear from you
                    </div>
                    <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-6">Contact FirstKnock</h1>
                    <p className="text-[#C7C7D8] text-lg leading-8 mb-8">
                        Have questions about using FirstKnock, improving your field sales routes, managing a canvassing team, or preparing your organization for growth? Reach out and we will help point you in the right direction.
                    </p>
                    <a
                        href="mailto:firstknockhelp@gmail.com"
                        className="flex items-center justify-between gap-4 rounded-2xl bg-white/5 border border-white/10 p-5 hover:bg-white/10 transition-colors"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-[#6C5CE7]/20 flex items-center justify-center">
                                <Mail className="w-6 h-6 text-[#A29BFE]" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold">Email support</h2>
                                <p className="text-[#8888A0]">firstknockhelp@gmail.com</p>
                            </div>
                        </div>
                        <ArrowRight className="w-5 h-5 text-[#A29BFE]" />
                    </a>
                </section>
            </div>
        </div>
    );
}