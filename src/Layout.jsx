import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, List, Upload, Settings, Navigation } from 'lucide-react';

export default function Layout({ children }) {
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
            <header className="bg-slate-800 border-b border-slate-700 p-4 z-20 shadow-md">
                <div className="flex justify-between items-center max-w-7xl mx-auto w-full">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center">
                            <span className="font-bold text-white text-lg">FK</span>
                        </div>
                        <h1 className="text-xl font-bold tracking-tight">FirstKnock</h1>
                    </div>
                    {/* Status Indicator */}
                    <div className="flex items-center gap-2">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                        <span className="text-xs text-slate-400 font-medium">ONLINE</span>
                    </div>
                </div>
            </header>

            {/* Main Content Area */}
            <main className="flex-1 relative overflow-hidden">
                {children}
            </main>

            {/* Bottom Navigation */}
            <nav className="bg-slate-800 border-t border-slate-700 z-20 safe-area-bottom">
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
                      label="Sync" 
                      to={createPageUrl('Sync')} 
                      active={window.location.pathname.endsWith('Sync')}
                    />
                    <NavItem 
                      icon={Settings} 
                      label="Settings" 
                      to="#" 
                      active={window.location.pathname.endsWith('Settings')}
                    />
                </div>
            </nav>
        </div>
    );
}

function NavItem({ icon: Icon, label, to, active }) {
    return (
        <Link to={to} className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors duration-200 ${active ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
            <Icon className={`w-6 h-6 ${active ? 'fill-current/20' : ''}`} />
            <span className="text-[10px] font-medium">{label}</span>
        </Link>
    );
}