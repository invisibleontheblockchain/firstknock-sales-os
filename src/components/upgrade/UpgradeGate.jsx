import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Lock, ArrowRight, Star } from 'lucide-react';
import { Button } from "@/components/ui/button";

const EXEMPT_EMAILS = [
    'christian@nativepest.com',
    'kevin@reefenvironmental.com',
    'christian@nativepestmanagement.com',
    'keven@reefenvironmental.com',
];

const FREE_HOUSE_LIMIT = 25;

export function shouldShowUpgradeGate(user, housesMarked) {
    if (!user) return false;
    // Subscribed or owner users never see the gate
    if (user.subscription_status === 'active' || user.subscription_status === 'trialing' || user.is_owner) return false;
    // Exempt emails
    const email = (user.email || '').trim().toLowerCase();
    if (EXEMPT_EMAILS.includes(email)) return false;
    // Check house count
    return housesMarked >= FREE_HOUSE_LIMIT;
}

export default function UpgradeGate({ onClose }) {
    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4" onClick={onClose}>
            <div 
                className="bg-[#111] border border-yellow-500/30 rounded-2xl p-6 max-w-sm w-full shadow-[0_0_60px_rgba(255,215,0,0.1)] animate-in zoom-in-95 duration-300"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-center mb-4">
                    <div className="w-14 h-14 rounded-full bg-yellow-500/10 flex items-center justify-center">
                        <Star className="w-7 h-7 text-yellow-500" />
                    </div>
                </div>
                
                <h2 className="text-xl font-extrabold text-white text-center mb-2">
                    You've Hit 25 Houses!
                </h2>
                <p className="text-gray-400 text-sm text-center mb-6 leading-relaxed">
                    You've been crushing it! Upgrade to FirstKnock Pro to keep logging results, get unlimited routes, and unlock your full territory.
                </p>

                <div className="space-y-3">
                    <Link to={createPageUrl('Billing')} className="block">
                        <Button className="w-full h-12 font-bold tracking-wide rounded-xl bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg">
                            <Lock className="w-4 h-4 mr-2" />
                            Upgrade to Pro — $49/mo
                            <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                    </Link>
                    
                    <button 
                        onClick={onClose}
                        className="w-full text-center text-xs text-gray-600 hover:text-gray-400 py-2 transition-colors"
                    >
                        Maybe later
                    </button>
                </div>
            </div>
        </div>
    );
}