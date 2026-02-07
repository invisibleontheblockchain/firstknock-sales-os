import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Map, List, Upload, Navigation, LogIn, Users, HelpCircle, Sparkles, Smartphone, MoreVertical, LogOut, RefreshCw, User as UserIcon } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import AiAssistant from '@/components/help/AiAssistant';
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';

class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false, error: null };
    }
  
    static getDerivedStateFromError(error) {
      return { hasError: true, error };
    }
  
    componentDidCatch(error, errorInfo) {
      console.error("Layout Error Boundary caught error:", error, errorInfo);
    }
  
    render() {
      if (this.state.hasError) {
        return (
          <div className="flex h-screen items-center justify-center bg-black text-white p-6 text-center">
            <div>
              <h2 className="text-xl font-bold text-red-500 mb-2">Something went wrong</h2>
              <pre className="text-xs text-gray-500 bg-gray-900 p-4 rounded text-left overflow-auto max-w-lg mx-auto">
                {this.state.error?.toString()}
              </pre>
              <button 
                onClick={() => window.location.reload()} 
                className="mt-6 bg-yellow-500 text-black font-bold px-6 py-2 rounded-full"
              >
                Reload App
              </button>
            </div>
          </div>
        );
      }
  
      return this.props.children;
    }
  }

export default function Layout({ children }) {
    // Handle /login 404 by redirecting to SignIn
    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
        window.location.replace('/SignIn');
        return null;
    }

    const [isOnline, setIsOnline] = React.useState(navigator.onLine);

    React.useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

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
                <img 
                    src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/695eb764b077190880be21de/4207f4197_ChatGPTImageFeb2202612_56_42AM.png" 
                    alt="FirstKnock Logo" 
                    className="w-24 h-24 rounded-2xl mb-4 shadow-[0_0_30px_rgba(255,215,0,0.3)] object-cover"
                />
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

    // Check if user needs to select role (first login)
    const isRoleSelectPage = window.location.pathname.includes('RoleSelect');
    const isRepPage = window.location.pathname.includes('RepHome');
    
    if (!user.app_role && !isRoleSelectPage) {
        // Redirect to role selection
        window.location.href = createPageUrl('RoleSelect');
        return null;
    }

    // If rep tries to access manager pages, redirect to RepHome (Disabled for debug)
    const managerPages = ['Home', 'Setup', 'AdminTeam', 'List'];
    const isManagerPage = managerPages.some(p => window.location.pathname.endsWith(p));
    // if (user.app_role === 'rep' && isManagerPage) {
    //     window.location.href = createPageUrl('RepHome');
    //     return null;
    // }

    return (
        <div className="flex flex-col h-[100dvh] font-sans overflow-hidden" style={{ background: '#0A0A0A', color: '#E5E5E5' }}>
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
                        <img 
                            src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/695eb764b077190880be21de/4207f4197_ChatGPTImageFeb2202612_56_42AM.png" 
                            alt="FK" 
                            className="w-8 h-8 rounded-lg object-cover"
                        />
                        <h1 className="text-lg font-bold tracking-tight text-white">FirstKnock</h1>
                    </div>

                    {/* Desktop Actions */}
                    <div className="hidden md:flex items-center gap-3">
                        {!isOnline && (
                            <div className="flex items-center gap-1 bg-red-900/50 px-2 py-1 rounded text-[10px] text-red-200 border border-red-800">
                                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                                OFFLINE
                            </div>
                        )}
                        
                        <button 
                            onClick={() => {
                                if(confirm("Reset Role?")) {
                                    base44.auth.updateMe({ app_role: null }).then(() => {
                                        window.location.href = createPageUrl('RoleSelect');
                                    });
                                }
                            }}
                            className="bg-red-600 text-white text-[10px] font-bold px-2 py-1 rounded mr-2"
                        >
                            RESET ROLE
                        </button>

                        <button
                            onClick={async () => {
                                try {
                                    await base44.auth.logout(window.location.origin);
                                } catch (e) {
                                    window.location.reload();
                                }
                                queryClient.clear();
                            }}
                            className="text-xs text-slate-400 hover:text-white"
                        >
                            LOGOUT
                        </button>
                        {user?.app_role !== 'rep' && (
                            <Link 
                                to={createPageUrl('RepHome')}
                                className="flex items-center justify-center px-3 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors text-[10px] font-bold text-yellow-500"
                            >
                                REP MODE
                            </Link>
                        )}
                        <Link 
                            to={createPageUrl('MobileApp')}
                            className="flex items-center justify-center w-8 h-8 bg-gray-800 hover:bg-gray-700 rounded-full transition-colors"
                        >
                            <Smartphone className="w-4 h-4 text-yellow-500" />
                        </Link>
                        <span 
                            className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} 
                            title={isOnline ? "System Online" : "Offline Mode Active"}
                        />
                    </div>

                    {/* Mobile Actions Menu */}
                    <div className="md:hidden flex items-center gap-2">
                        {!isOnline && (
                            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse mr-1" title="Offline" />
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="text-white hover:bg-slate-800 h-8 w-8">
                                    <MoreVertical className="w-5 h-5" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56 bg-[#0A0A0A] border-slate-800 text-white shadow-xl">
                                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                                <DropdownMenuSeparator className="bg-slate-800" />
                                
                                {user?.app_role !== 'rep' && (
                                    <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer">
                                        <Link to={createPageUrl('RepHome')} className="flex items-center w-full">
                                            <UserIcon className="mr-2 h-4 w-4" />
                                            <span>Switch to Rep Mode</span>
                                        </Link>
                                    </DropdownMenuItem>
                                )}
                                
                                <DropdownMenuItem asChild className="focus:bg-slate-800 focus:text-white cursor-pointer">
                                    <Link to={createPageUrl('MobileApp')} className="flex items-center w-full">
                                        <Smartphone className="mr-2 h-4 w-4" />
                                        <span>Get Mobile App</span>
                                    </Link>
                                </DropdownMenuItem>

                                <DropdownMenuSeparator className="bg-slate-800" />

                                <DropdownMenuItem onClick={() => {
                                    if(confirm("Reset Role?")) {
                                        base44.auth.updateMe({ app_role: null }).then(() => {
                                            window.location.href = createPageUrl('RoleSelect');
                                        });
                                    }
                                }} className="text-red-400 focus:text-red-400 focus:bg-red-900/20 cursor-pointer">
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                    <span>Reset Role</span>
                                </DropdownMenuItem>
                                
                                <DropdownMenuItem onClick={async () => {
                                    try {
                                        await base44.auth.logout(window.location.origin);
                                    } catch (e) {
                                        window.location.reload();
                                    }
                                    queryClient.clear();
                                }} className="focus:bg-slate-800 focus:text-white cursor-pointer">
                                    <LogOut className="mr-2 h-4 w-4" />
                                    <span>Logout</span>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </header>

            {/* Main Content Area */}
            <main className="flex-1 relative overflow-hidden">
                <ErrorBoundary>
                    {children}
                </ErrorBoundary>
                <AiAssistant />
                <OnboardingWizard user={user} />
            </main>

            {/* Bottom Navigation - Different for Rep vs Manager */}
            <nav className="bg-black border-t border-slate-800 z-20 safe-area-bottom shrink-0">
                {user.app_role === 'rep' ? (
                    // Rep Navigation - Simple
                    <div className="flex justify-around items-center h-16 max-w-full mx-auto">
                        <NavItem
                            icon={Map}
                            label="My Route"
                            to={createPageUrl('RepHome')}
                            active={window.location.pathname.includes('RepHome') || window.location.pathname === '/'}
                        />
                        <NavItem
                            icon={HelpCircle}
                            label="Help"
                            to={createPageUrl('Tutorial')}
                            active={window.location.pathname.endsWith('Tutorial')}
                        />
                    </div>
                ) : (
                    // Manager Navigation - Full
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
                        <NavItem
                            icon={Sparkles}
                            label="Plans"
                            to={createPageUrl('Billing')}
                            active={window.location.pathname.endsWith('Billing')}
                        />
                        </div>
                        )}
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