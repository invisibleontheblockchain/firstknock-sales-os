import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, List, Navigation, Upload, Settings } from 'lucide-react';

export default function Layout({ children }) {
    const path = window.location.pathname;
    
    return (
        <div className="flex flex-col h-screen bg-slate-900 text-slate-100 font-sans overflow-hidden">
            {/* Header */}
            <header className="bg-slate-800 border-b border-slate-700 px-4 py-3 z-20">
                <div className="flex justify-between items-center max-w-7xl mx-auto">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center">
                            <span className="font-bold text-white text-sm">FK</span>
                        </div>
                        <h1 className="text-lg font-bold tracking-tight">FirstKnock</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                        <span className="text-xs text-slate-400">ONLINE</span>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 relative overflow-hidden">
                {children}
            </main>

            {/* Bottom Navigation */}
            <nav className="bg-slate-800 border-t border-slate-700 z-20">
                <div className="flex justify-around items-center h-14 max-w-md mx-auto">
                    <NavItem icon={Map} label="Map" to={createPageUrl('Home')} active={path.endsWith('Home') || path === '/'} />
                    <NavItem icon={List} label="List" to={createPageUrl('List')} active={path.endsWith('List')} />
                    <NavItem icon={Navigation} label="Routes" to={createPageUrl('Routes')} active={path.endsWith('Routes')} />
                    <NavItem icon={Upload} label="Sync" to={createPageUrl('Sync')} active={path.endsWith('Sync')} />
                </div>
            </nav>
        </div>
    );
}

function NavItem({ icon: Icon, label, to, active }) {
    return (
        <Link to={to} className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors ${active ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
            <Icon className="w-5 h-5" />
            <span className="text-[10px] font-medium">{label}</span>
        </Link>
    );
}