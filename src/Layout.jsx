import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, List, Upload, Navigation, LogIn, Users, HelpCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export default function Layout({ children }) {
    const queryClient = useQueryClient();
    const { data: user, isLoading } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
        retry: false
    });

    if (isLoading) {
        return (
            <div className="flex h-screen items-center justify-center bg-black text-white">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-yellow-500"></div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="flex h-screen flex-col items-center justify-center bg-black text-white p-6 text-center space-y-6">
                <div className="w-20 h-20 bg-yellow-500 rounded-2xl flex items-center justify-center mb-4 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                    <Navigation className="w-10 h-10 text-black" />
                </div>
                <h1 className="text-3xl font-bold tracking-tight">FirstKnock</h1>
                <p className="text-gray-400 max-w-xs">
                    Your personal door-to-door sales territory manager. Login to access your secure data.
                </p>
                <Button
                    onClick={() => base44.auth.redirectToLogin()}
                    className="w-full max-w-xs h-12 bg-yellow-500 text-black font-bold hover:bg-yellow-400 text-base"
                >
                    <LogIn className="w-5 h-5 mr-2" />
                    LOGIN / SIGN UP
                </Button>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen font-sans overflow-hidden" style={{ background: '#0A0A0A', color: '#E5E5E5' }}>
            {/* Brand Theme + Map Styles */}
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
                
                body { font-family: 'Inter', sans-serif; }
                h1, h2, h3, h4, h5, h6 { font-family: 'Montserrat', sans-serif; }
                
                .leaflet-container {
                    background: #0A0A0A !important;
                }
                .route-number-tooltip {
                    background: transparent !important;
                    border: none !important;
                    box-shadow: none !important;
                    padding: 0 !important;
                }
                .route-number-tooltip::before {
                    display: none !important;
                }
            `}</style>

            {/* Header */}
            <header className="bg-black border-b border-slate-800 px-4 pt-[env(safe-area-inset-top)] pb-3 z-20 shadow-md">
                <div className="flex justify-between items-center max-w-7xl mx-auto w-full pt-3">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-yellow-500 rounded-lg flex items-center justify-center">
                            <span className="text-black font-bold text-sm">FK</span>
                        </div>
                        <h1 className="text-lg font-bold tracking-tight text-white">FirstKnock</h1>
                    </div>
                    {/* Status Indicator */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={async () => {
                                try {
                                    await base44.auth.logout();
                                } catch (e) {
                                    console.log('Logout error:', e);
                                }
                                // Clear all cached queries
                                queryClient.clear();
                                // Force page reload to reset auth state
                                window.location.reload();
                            }}
                            className="text-xs text-slate-400 hover:text-white mr-2"
                        >
                            LOGOUT
                        </button>
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    </div>
                </div>
            </header>

            {/* Main Content Area */}
            <main className="flex-1 relative overflow-hidden">
                {children}
            </main>

            {/* Bottom Navigation */}
            <nav className="bg-black border-t border-slate-800 z-20 safe-area-bottom">
                <div className="flex justify-around items-center h-16 max-w-full mx-auto">
                    <NavItem
                        icon={Map}
                        label="Map"
                        to={createPageUrl('Home')}
                        active={window.location.pathname.endsWith('Home') || window.location.pathname === '/'}
                    />
                    <NavItem
                        icon={List}
                        label="List"
                        to={createPageUrl('List')}
                        active={window.location.pathname.endsWith('List')}
                    />

                    <NavItem
                        icon={Upload}
                        label="Setup"
                        to={createPageUrl('Setup')}
                        active={window.location.pathname.endsWith('Setup')}
                    />
                    <NavItem
                        icon={Users}
                        label="Team"
                        to={createPageUrl('AdminTeam')}
                        active={window.location.pathname.endsWith('AdminTeam')}
                    />
                    <NavItem
                        icon={HelpCircle}
                        label="Help"
                        to={createPageUrl('Tutorial')}
                        active={window.location.pathname.endsWith('Tutorial')}
                    />
                </div>
            </nav>
        </div>
    );
}

function NavItem({ icon: Icon, label, to, active }) {
    return (
        <Link to={to} className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors duration-200 ${active ? 'text-yellow-400' : 'text-white hover:text-yellow-300'}`}>
            <Icon className={`w-6 h-6 ${active ? 'fill-current/20' : ''}`} />
            <span className="text-[10px] font-medium">{label}</span>
        </Link>
    );
}