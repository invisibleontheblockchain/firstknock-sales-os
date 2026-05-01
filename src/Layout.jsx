import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, Upload, Navigation, LogIn, Users, HelpCircle, Sparkles, Smartphone, MoreVertical, LogOut, RefreshCw, User as UserIcon, TrendingUp, Paintbrush, Gift, Calendar, Mail } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import AiAssistant from '@/components/help/AiAssistant';
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';
import MarketOnboarding from '@/components/onboarding/MarketOnboarding';
import { ThemeProvider, useTheme, contrastText } from '@/components/theme/ThemeProvider';

class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { hasError: false, error: null }; }
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    componentDidCatch(error, errorInfo) { console.error("Layout Error Boundary caught error:", error, errorInfo); }
    render() {
      if (this.state.hasError) {
        return (
          <div className="flex h-screen items-center justify-center bg-black text-white p-6 text-center">
            <div>
              <h2 className="text-xl font-bold text-red-500 mb-2">Something went wrong</h2>
              <pre className="text-xs text-gray-500 bg-gray-900 p-4 rounded text-left overflow-auto max-w-lg mx-auto">{this.state.error?.toString()}</pre>
              <button onClick={() => window.location.reload()} className="mt-6 bg-yellow-500 text-black font-bold px-6 py-2 rounded-full">Reload App</button>
            </div>
          </div>
        );
      }
      return this.props.children;
    }
}

function LayoutInner({ children }) {
    const { accent } = useTheme();
    const accentText = contrastText(accent);

    const [isOnline, setIsOnline] = React.useState(navigator.onLine);
    const queryClient = useQueryClient();
    const { data: user, isLoading } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), retry: false });

    React.useEffect(() => {
        if (typeof window !== 'undefined' && window.location.pathname === '/login') {
            window.location.replace('/SignIn');
        }
    }, []);

    React.useEffect(() => {
        const on = () => setIsOnline(true);
        const off = () => setIsOnline(false);
        window.addEventListener('online', on);
        window.addEventListener('offline', off);

        // Update App Metadata (Title & Icons) for consistency
        document.title = "FirstKnock Sales OS";
        
        // Golden Door Icon for Home Screen
        const LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/695eb764b077190880be21de/1a36819e1_IMG_0921.jpeg";
        
        const updateLink = (rel, href) => {
            // Remove any existing links of this type to ensure ours takes precedence
            const existing = document.querySelectorAll(`link[rel="${rel}"]`);
            existing.forEach(e => e.remove());

            const link = document.createElement('link');
            link.rel = rel;
            link.href = href;
            document.head.appendChild(link);
        };
        
        updateLink('icon', LOGO_URL);
        updateLink('apple-touch-icon', LOGO_URL);
        updateLink('apple-touch-icon-precomposed', LOGO_URL);

        // Prevent zoom on mobile inputs
        const viewportMeta = document.querySelector('meta[name="viewport"]');
        if (viewportMeta) {
            viewportMeta.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
        }

        return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
    }, []);

    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
        return null;
    }

    if (isLoading) {
        return (
            <div className="flex h-screen items-center justify-center bg-black text-white">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2" style={{ borderColor: accent }}></div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="flex h-screen flex-col items-center justify-center relative overflow-hidden bg-[#0A0A0F] text-white p-6 text-center">
                {/* Animated Grid Background */}
                <div className="absolute inset-0 pointer-events-none" style={{
                    backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px)',
                    backgroundSize: '40px 40px',
                    maskImage: 'linear-gradient(to bottom, transparent, black, transparent)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent, black, transparent)'
                }}></div>
                {/* Purple Glow */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-[#6C5CE7]/20 blur-[120px] rounded-full pointer-events-none"></div>
                
                <div className="relative z-10 flex flex-col items-center space-y-8 max-w-sm w-full">
                    <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/695eb764b077190880be21de/4207f4197_ChatGPTImageFeb2202612_56_42AM.png" alt="FirstKnock Logo" className="w-20 h-20 rounded-2xl object-cover shadow-[0_0_40px_rgba(108,92,231,0.5)] border border-white/10" />
                    
                    <div className="space-y-3">
                        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-[#A29BFE]" style={{ textShadow: '0 0 40px rgba(108,92,231,0.3)' }}>FirstKnock</h1>
                        <p className="text-[#8888A0] text-lg font-medium tracking-wide">The Door-to-Door Sales OS.</p>
                    </div>

                    <button 
                        onClick={() => base44.auth.redirectToLogin()} 
                        className="w-full h-14 rounded-xl flex items-center justify-center gap-3 font-bold text-lg transition-all duration-300 transform hover:-translate-y-1 glass-card"
                        style={{
                            background: 'linear-gradient(135deg, rgba(108,92,231,0.2), rgba(0,210,255,0.1))',
                            boxShadow: '0 8px 32px rgba(108,92,231,0.2)',
                            border: '1px solid rgba(255,255,255,0.1)'
                        }}
                    >
                        <LogIn className="w-5 h-5 text-[#A29BFE]" /> 
                        <span className="text-white">Sign In / Sign Up</span>
                    </button>
                </div>
            </div>
        );
    }

    const isRoleSelectPage = window.location.pathname.includes('RoleSelect');
    if (!user.app_role && !isRoleSelectPage) { window.location.href = createPageUrl('RoleSelect'); return null; }

    return (
        <div className="flex flex-col h-[100dvh] font-sans overflow-hidden bg-[#0A0A0F] text-[#F0F0F5]">
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');
                
                :root {
                    --bg-primary: #0A0A0F;
                    --bg-surface: #12121A;
                    --bg-surface-hover: #1A1A2E;
                    --primary: #6C5CE7;
                    --primary-light: #A29BFE;
                    --secondary: #00D2FF;
                    --success: #00F5A0;
                    --warning: #FFD93D;
                    --danger: #FF6B6B;
                    --text-primary: #F0F0F5;
                    --text-secondary: #8888A0;
                }

                body { font-family: 'Inter', sans-serif; background-color: var(--bg-primary); color: var(--text-primary); }
                h1, h2, h3, h4, h5, h6 { font-family: 'Outfit', sans-serif; letter-spacing: -0.02em; }
                .font-mono { font-family: 'JetBrains Mono', monospace; }
                
                /* Glassmorphism */
                .glass-card {
                    background: rgba(18, 18, 26, 0.8);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                
                .glass-panel {
                    background: rgba(18, 18, 26, 0.95);
                    backdrop-filter: blur(10px);
                    border-top: 1px solid rgba(255, 255, 255, 0.05);
                }

                /* Scrollbar */
                ::-webkit-scrollbar { width: 6px; height: 6px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 3px; }
                ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.2); }

                .leaflet-container { background: #0A0A0F !important; }
                .route-number-tooltip { background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important; }
                .route-number-tooltip::before { display: none !important; }
                .zip-label-tooltip { background: rgba(0,0,0,0.75) !important; border: 1px solid rgba(255,255,255,0.15) !important; box-shadow: 0 2px 12px rgba(0,0,0,0.5) !important; padding: 4px 8px !important; border-radius: 6px !important; text-align: center !important; }
                .zip-label-tooltip::before { border-bottom-color: rgba(0,0,0,0.75) !important; }
            `}</style>

            {/* Header */}
            {!isRoleSelectPage && (
            <header className="bg-black border-b border-slate-800 px-4 pt-[env(safe-area-inset-top)] pb-3 z-20 shadow-md">
                <div className="flex items-center w-full pt-3">
                    <div className="flex items-center gap-3 mr-auto">
                        <img src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/695eb764b077190880be21de/4207f4197_ChatGPTImageFeb2202612_56_42AM.png" alt="FK" className="w-8 h-8 rounded-lg object-cover" />
                        <h1 className="text-lg font-bold tracking-tight text-white">FirstKnock</h1>
                    </div>

                    {/* Desktop */}
                    <div className="hidden md:flex items-center gap-3 ml-auto">
                        {!isOnline && <div className="flex items-center gap-1 bg-red-900/50 px-2 py-1 rounded text-[10px] text-red-200 border border-red-800"><div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />OFFLINE</div>}

                        <Link to="/About" className="flex items-center justify-center px-3 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors text-[10px] font-bold text-white">ABOUT</Link>
                        <Link to="/Contact" className="flex items-center justify-center px-3 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors text-[10px] font-bold text-white">CONTACT</Link>
                        <Link to={createPageUrl('Setup')} className="flex items-center justify-center px-3 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors text-[10px] font-bold text-white">SETUP</Link>
                        <Link to={createPageUrl('Billing')} className="flex items-center justify-center px-3 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors text-[10px] font-bold text-white">PLANS</Link>
                        <button onClick={async () => { try { await base44.auth.logout(window.location.origin); } catch { window.location.reload(); } queryClient.clear(); }} className="text-xs text-slate-400 hover:text-white">LOGOUT</button>
                        <Link to={createPageUrl('MobileApp')} className="flex items-center justify-center w-8 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.6)]"><Smartphone className="w-4 h-4" /></Link>
                        <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                    </div>

                    {/* Mobile */}
                    <div className="md:hidden flex items-center gap-2">
                        {!isOnline && <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse mr-1" />}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="text-white hover:bg-slate-800 h-8 w-8"><MoreVertical className="w-5 h-5" /></Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56 bg-[#0A0A0A] border-slate-800 text-white shadow-xl">
                                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                                <DropdownMenuSeparator className="bg-slate-800" />
                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer"><Link to={createPageUrl('Setup')} className="flex items-center w-full"><Upload className="mr-2 h-4 w-4" /><span>Setup</span></Link></DropdownMenuItem>
                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer"><Link to={createPageUrl('Billing')} className="flex items-center w-full"><Sparkles className="mr-2 h-4 w-4" /><span>Plans</span></Link></DropdownMenuItem>
                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer"><Link to={createPageUrl('MobileApp')} className="flex items-center w-full"><Smartphone className="mr-2 h-4 w-4" /><span>Get Mobile App</span></Link></DropdownMenuItem>
                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer"><Link to="/About" className="flex items-center w-full"><HelpCircle className="mr-2 h-4 w-4" /><span>About</span></Link></DropdownMenuItem>
                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer"><Link to="/Contact" className="flex items-center w-full"><Mail className="mr-2 h-4 w-4" /><span>Contact</span></Link></DropdownMenuItem>

                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer"><Link to={createPageUrl('Referrals')} className="flex items-center w-full"><Gift className="mr-2 h-4 w-4" /><span>Referrals</span></Link></DropdownMenuItem>
                                <DropdownMenuSeparator className="bg-slate-800" />
                                <DropdownMenuItem onClick={async () => { try { await base44.auth.logout(window.location.origin); } catch { window.location.reload(); } queryClient.clear(); }} className="focus:bg-slate-800 focus:text-white cursor-pointer"><LogOut className="mr-2 h-4 w-4" /><span>Logout</span></DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </header>
            )}



            <main className="flex-1 relative overflow-hidden">
                <ErrorBoundary>{children}</ErrorBoundary>
                <AiAssistant />
                <OnboardingWizard user={user} />
                <MarketOnboarding 
                    user={user} 
                    onComplete={({ method, shape }) => {
                        if (method === 'draw') {
                            // Navigate to Home and trigger drawing mode with chosen shape
                            window.location.href = createPageUrl('Home') + '?startDraw=true' + (shape ? `&drawShape=${shape}` : '');
                        }
                    }}
                />
            </main>

            {/* Bottom Nav */}
            {!isRoleSelectPage && (
            <nav className="bg-black border-t border-slate-800 z-20 safe-area-bottom shrink-0">
                {user.app_role === 'rep' ? (
                    <div className="flex justify-around items-center h-16 max-w-full mx-auto">
                        <NavItem icon={Map} label="My Route" to={createPageUrl('RepHome')} active={window.location.pathname.includes('RepHome') || window.location.pathname === '/'} accent={accent} />
                        <NavItem icon={HelpCircle} label="Help" to={createPageUrl('Tutorial')} active={window.location.pathname.endsWith('Tutorial')} accent={accent} />
                    </div>
                ) : (
                    <div className="flex justify-around items-center h-16 max-w-full mx-auto">
                        <NavItem icon={Map} label="Map" to={createPageUrl('Home')} active={window.location.pathname.endsWith('Home') || window.location.pathname === '/'} accent={accent} />
                        <NavItem icon={Navigation} label="Knock" to={(() => { try { const id = localStorage.getItem('fk_selectedKnockRouteId'); return createPageUrl('RepHome') + (id ? `?route=${encodeURIComponent(id)}` : ''); } catch { return createPageUrl('RepHome'); } })()} active={window.location.pathname.includes('RepHome')} accent={accent} />
                        <NavItem icon={TrendingUp} label="Analytics" to={createPageUrl('List')} active={window.location.pathname.endsWith('List')} accent={accent} />
                        <NavItem icon={Calendar} label="Appts" to={createPageUrl('Appointments')} active={window.location.pathname.endsWith('Appointments')} accent={accent} />
                        <NavItem icon={Users} label="Team" to={createPageUrl('AdminTeam')} active={window.location.pathname.endsWith('AdminTeam')} accent={accent} />
                    </div>
                )}
            </nav>
            )}
        </div>
    );
}

function NavItem({ icon: Icon, label, to, active }) {
    return (
        <Link 
            to={to}
            onClick={() => {
                if (label === 'Map') window.dispatchEvent(new CustomEvent('fk-map-tab-open'));
            }}
            className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-all duration-300 ${
                active ? 'text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.8)]' : 'text-[#9CA3AF] hover:text-gray-300'
            }`}
        >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] font-medium">{label}</span>
        </Link>
    );
}

export default function Layout({ children }) {
    return (
        <ThemeProvider>
            <LayoutInner>{children}</LayoutInner>
        </ThemeProvider>
    );
}