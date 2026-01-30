import React from 'react';
import { Button } from "@/components/ui/button";
import { ArrowLeft, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Terms() {
    const navigate = useNavigate();

    return (
        <div className="min-h-screen bg-black text-white p-6 md:p-12">
            <div className="max-w-3xl mx-auto space-y-8">
                <Button variant="ghost" onClick={() => navigate(-1)} className="pl-0 hover:bg-transparent hover:text-yellow-500">
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back
                </Button>

                <div className="space-y-4">
                    <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center mb-4">
                        <Shield className="w-6 h-6 text-black" />
                    </div>
                    <h1 className="text-3xl font-bold">Terms & Privacy</h1>
                    <p className="text-gray-400 text-lg">The Orchestrator's Constitution.</p>
                </div>

                <div className="space-y-8 text-gray-300 leading-relaxed">
                    <section className="space-y-2">
                        <h2 className="text-xl font-bold text-white">1. Data Sovereignty</h2>
                        <p>
                            FirstKnock ("The Service") is designed with a "Local First, Cloud Optional" philosophy. 
                            While we provide cloud sync capabilities for team collaboration, the user ("The Admin") retains ownership of their generated data.
                            We do not sell, trade, or analyze your territory data for third-party marketing.
                        </p>
                    </section>

                    <section className="space-y-2">
                        <h2 className="text-xl font-bold text-white">2. Geolocation Usage</h2>
                        <p>
                            The Service uses background geolocation solely for the purpose of verifying door knocks ("GPS Proof") and optimizing route traversal.
                            Location data is stored securely and is only accessible to your team's administrators.
                        </p>
                    </section>

                    <section className="space-y-2">
                        <h2 className="text-xl font-bold text-white">3. User Conduct</h2>
                        <p>
                            Users agree to use The Service in compliance with all local laws and regulations regarding door-to-door solicitation.
                            FirstKnock assumes no liability for the actions of representatives in the field.
                        </p>
                    </section>

                    <section className="space-y-2">
                        <h2 className="text-xl font-bold text-white">4. Account Termination</h2>
                        <p>
                            Users may delete their account and associated data at any time via the "Delete Account" page.
                            Upon deletion, data is removed from active servers immediately and from backups within 30 days.
                        </p>
                    </section>
                </div>

                <div className="pt-8 border-t border-gray-800 text-xs text-gray-500">
                    Last Updated: January 2026
                </div>
            </div>
        </div>
    );
}