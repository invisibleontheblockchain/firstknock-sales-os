import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { isRepAccount, getManagerIdForAccount } from '@/lib/roles';
import { startRepLocationSession } from '@/lib/repLocationSession';
import { useShiftStatus, activeShiftFor } from '@/lib/useShiftStatus';
import { LOCATION_LIVE_MS } from '../../../base44/shared/repLocations';

const SharingContext = createContext(null);

// Reps share their location with their manager exactly while they are clocked in:
// clocking in starts it and clocking out stops it. There is no separate switch.
export function RepLocationProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), enabled: isAuthenticated, retry: false });
  const eligible = isAuthenticated && isRepAccount(user) && !!getManagerIdForAccount(user);
  const status = useShiftStatus(user, isAuthenticated && !!user?.id);
  const shift = eligible ? activeShiftFor(status, user) : null;
  const sharing = !!shift;
  const [state, setState] = useState({ error: '', lastPublished: null });
  const [now, setNow] = useState(Date.now());
  const sessionRef = useRef(null);

  useEffect(() => {
    if (!sharing) return undefined;
    let mounted = true;
    setState({ error: '', lastPublished: null });
    const session = startRepLocationSession({
      geolocation: navigator.geolocation,
      sessionId: crypto.randomUUID(),
      invoke: async (body) => {
        const response = await base44.functions.invoke('repLocations', body);
        if (!response.data?.success) throw new Error('Location update failed.');
      },
      onState: (update) => { if (mounted) setState(previous => ({ ...previous, ...update })); },
    });
    sessionRef.current = session;
    // Browsers pause GPS while the phone is locked or the app is in the background;
    // send a fresh position the moment the rep comes back.
    const resume = () => { if (document.visibilityState === 'visible') session.refresh(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mounted = false;
      clearInterval(tick);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      if (sessionRef.current === session) sessionRef.current = null;
      session.stop().catch(() => {});
    };
  }, [sharing, shift?.id, user?.id, user?.team_manager_id, user?.data?.team_manager_id]);

  const live = sharing && !state.error && state.lastPublished && now - state.lastPublished <= LOCATION_LIVE_MS;
  return <SharingContext.Provider value={{ eligible, sharing, live, state, verificationError: status.isError }}>{children}</SharingContext.Provider>;
}

export default function RepLocationSharing() {
  const context = useContext(SharingContext);
  if (!context?.eligible) return null;
  const { sharing, live, state, verificationError } = context;
  const title = verificationError ? 'Location sharing paused: your shift could not be verified'
    : !sharing ? 'Location sharing starts when you clock in'
      : live ? 'On the clock · location live with your manager' : 'On the clock · connecting your location…';
  const detail = verificationError ? 'Check your connection. Sharing resumes once your shift is confirmed.'
    : !sharing ? 'Your manager sees where you are only while you are clocked in. Clocking out stops it.'
      : state.error || 'Keep FirstKnock open while you canvass. Updates pause while your phone is locked or the app is closed, and resume when you come back.';
  return (
    <div className="border-b border-white/10 bg-[#111] px-4 py-2 text-white">
      <p className="flex items-center gap-2 text-xs font-semibold"><MapPin className={`h-3.5 w-3.5 ${live ? 'text-green-400' : 'text-gray-400'}`} />{title}</p>
      <p className={`mt-1 text-[10px] ${sharing && state.error ? 'text-amber-300' : 'text-gray-400'}`} role={sharing && state.error ? 'alert' : undefined}>{detail}</p>
    </div>
  );
}
