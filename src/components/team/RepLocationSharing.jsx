import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { isRepAccount, getManagerIdForAccount } from '@/lib/roles';
import { startRepLocationSession } from '@/lib/repLocationSession';
import { LOCATION_LIVE_MS } from '../../../base44/shared/repLocations';

const SharingContext = createContext(null);

export function RepLocationProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), enabled: isAuthenticated, retry: false });
  const eligible = isAuthenticated && isRepAccount(user) && !!getManagerIdForAccount(user);
  const [sharingFor, setSharingFor] = useState(null);
  const [state, setState] = useState({ error: '', lastPublished: null });
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sessionRef = useRef(null);
  const sharing = eligible && sharingFor === user?.id;

  useEffect(() => {
    if (!sharing) return undefined;
    let mounted = true;
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
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mounted = false;
      clearInterval(tick);
      if (sessionRef.current === session) sessionRef.current = null;
      session.stop().catch(() => {});
    };
  }, [sharing, user?.id, user?.team_manager_id, user?.data?.team_manager_id]);

  async function toggle() {
    if (stopping) return;
    if (!sharing) {
      setState({ error: '', lastPublished: null });
      setSharingFor(user.id);
      return;
    }
    setStopping(true);
    try {
      await sessionRef.current?.stop();
      setState({ error: '', lastPublished: null });
    } catch {
      setState({ error: 'Sharing stopped on this device. The manager’s live signal expires within one minute.', lastPublished: null });
    } finally {
      setSharingFor(null);
      setStopping(false);
    }
  }
  const live = sharing && !stopping && !state.error && state.lastPublished && now - state.lastPublished <= LOCATION_LIVE_MS;
  return <SharingContext.Provider value={{ eligible, sharing, stopping, live, state, toggle }}>{children}</SharingContext.Provider>;
}

export default function RepLocationSharing() {
  const context = useContext(SharingContext);
  if (!context?.eligible) return null;
  const { sharing, stopping, live, state, toggle } = context;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#111] px-4 py-2 text-white">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-xs font-semibold"><MapPin className={`h-3.5 w-3.5 ${live ? 'text-green-400' : 'text-gray-400'}`} />
          {live ? 'Location live with your manager' : sharing ? 'Connecting your field location…' : 'Share your field location with your manager'}
        </p>
        <p className={`mt-1 text-[10px] ${state.error ? 'text-amber-300' : 'text-gray-400'}`} role={state.error ? 'alert' : undefined}>
          {state.error || 'Updates while the app is open. Stop sharing when you finish in the field.'}
        </p>
      </div>
      <button type="button" onClick={toggle} disabled={stopping} aria-pressed={sharing}
        className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-white/20 px-3 text-xs font-bold hover:bg-white/10 disabled:opacity-50">
        {stopping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{sharing ? 'Stop sharing' : 'Share location'}
      </button>
    </div>
  );
}
