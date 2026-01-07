import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, List, Upload, Settings } from 'lucide-react';

export default function Layout({ children }) {
    return (
        <div className="flex flex-col h-screen bg-slate-900 text-slate-100 font-sans overflow-hidden">
            {/* Dark Mode Map Style Injection for Leaflet */}
            <style>{`
                .leaflet-container {
                    background: #1e293b !important;
                }
                .leaflet-layer,
                .leaflet-control-zoom-in,
                .leaflet-control-zoom-out,
                .leaflet-control-attribution {
                    filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%);
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
                <div className="flex justify-around items-center h-16 max-w-md mx-auto">
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