import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, List, Upload, Settings, Navigation, LogIn } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export default function Layout({ children }) {
    const { data: user, isLoading, error } = useQuery({
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
            `}</style>
            
            {/* Header */}
            <header className="bg-black border-b border-slate-800 p-4 z-20 shadow-md">
                <div className="flex justify-between items-center max-w-7xl mx-auto w-full">
                    <div className="flex items-center gap-2">
                        <svg width="32" height="32" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M256 100 L400 120 V400 L256 420 V100 Z" fill="#FFD700" stroke="none" style={{filter: 'drop-shadow(0 0 8px rgba(255, 215, 0, 0.5))'}}/>
                            <rect x="150" y="80" width="220" height="360" rx="4" stroke="#333333" strokeWidth="12" fill="none"/>
                            <path d="M160 90 L256 100 V410 L160 420 V90 Z" fill="#0A0A0A" stroke="#1F1F1F" strokeWidth="2"/>
                            <rect x="235" y="240" width="8" height="24" rx="2" fill="#FFD700"/>
                        </svg>
                        <h1 className="text-xl font-bold tracking-tight text-white">FirstKnock</h1>
                    </div>
                    {/* Status Indicator */}
                    <div className="flex items-center gap-2">
                         <button onClick={() => base44.auth.logout()} className="text-xs text-slate-400 hover:text-white mr-2">
                            LOGOUT
                        </button>
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                        <span className="text-xs text-slate-400 font-medium truncate max-w-[100px]">{user?.email}</span>
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