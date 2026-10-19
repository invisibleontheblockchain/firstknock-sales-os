import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Car } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { readAutoDrivingConsent, writeAutoDrivingConsent, autoDrivingStorageKey, startAutoDrivingTracker, startExclusiveAutoDrivingTracker } from '@/lib/autoDrivingTracker';
import { useShiftStatus } from '@/lib/useShiftStatus';

const AutoDrivingContext = createContext(null);
const readConsent = userId => { try { return readAutoDrivingConsent(localStorage, userId); } catch { return false; } };
const deviceStorage = { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };

export function AutoDrivingProvider({ children }) {
    const { isAuthenticated } = useAuth();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), enabled: isAuthenticated, retry: false });
    const signedIn = isAuthenticated && !!user?.id;
    const status = useShiftStatus(user, signedIn);
    const eligible = signedIn && !status.isError && status.data?.eligible === true;
    const managerId = eligible ? status.data.manager_id : null;
    const [consentFor, setConsentFor] = useState(null);
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
    const [state, setState] = useState({ error: '', lastObserved: null, queued_batches: 0 });
    const tracker = useRef(null);
    const transition = useRef(Promise.resolve());
    const identityRef = useRef(null);
    identityRef.current = eligible ? { id: user.id, managerId } : null;
    const consent = eligible && consentFor === user?.id;
    useEffect(() => { setConsentFor(eligible && readConsent(user.id) ? user.id : null); setState({ error: '', lastObserved: null, queued_batches: 0 }); }, [eligible, user?.id]);
    useEffect(() => {
        const changed = () => setVisible(document.visibilityState === 'visible');
        document.addEventListener('visibilitychange', changed);
        return () => document.removeEventListener('visibilitychange', changed);
    }, []);
    const shift = status.data?.current_shift;
    const verifiedShift = consent && visible && !status.isError && shift?.status === 'active'
        && shift.manager_id === managerId && shift.rep_user_id === user?.id ? shift : null;
    useEffect(() => {
        if (!verifiedShift || !eligible) return undefined;
        let active = true, session = null;
        const online = () => session?.flush();
        // A previous session can still be flushing. Start one storage writer at
        // a time so its completion cannot overwrite the new session's buffer.
        Promise.resolve(transition.current).catch(() => {}).then(() => {
            if (!active) return;
            setState({ error: '', lastObserved: null, queued_batches: 0 });
            const updateState = update => { if (active) setState(previous => ({ ...previous, ...update })); };
            session = startExclusiveAutoDrivingTracker({ locks: navigator.locks, lockName: autoDrivingStorageKey(user.id, managerId),
                onState: updateState, start: () => startAutoDrivingTracker({ geolocation: navigator.geolocation, storage: deviceStorage,
            storageKey: autoDrivingStorageKey(user.id, managerId), shiftId: verifiedShift.id, sessionId: crypto.randomUUID(),
            invoke: async body => {
                if (identityRef.current?.id !== user.id || identityRef.current?.managerId !== managerId) {
                    const error = new Error('The mileage account changed.'); error.status = 401; throw error;
                }
                const response = await base44.functions.invoke('autoDriving', body);
                if (!response.data?.success || response.data.manager_id !== managerId) throw new Error('GPS batch could not be verified.');
                return response.data;
            }, onState: updateState }) });
            tracker.current = session;
            window.addEventListener('online', online);
        });
        return () => {
            active = false; window.removeEventListener('online', online);
            if (tracker.current === session) tracker.current = null;
            // Flush captured samples after clock-out/visibility changes only while
            // this exact account/company remains authenticated. Logout never starts a flush.
            const sameIdentity = identityRef.current?.id === user.id && identityRef.current?.managerId === managerId;
            if (session) transition.current = session.stop({ flushPending: sameIdentity }).catch(() => {});
        };
    }, [eligible, verifiedShift?.id, user?.id, managerId, status.data?.member_id]);
    function setEnabled(enabled) {
        try { writeAutoDrivingConsent(localStorage, user.id, enabled); }
        catch { setState(previous => ({ ...previous, error: 'Device storage is unavailable. This preference may not persist.' })); }
        setConsentFor(enabled ? user.id : null);
    }
    const verifiedEligible = signedIn && status.data?.eligible === true;
    return <AutoDrivingContext.Provider value={{ eligible: verifiedEligible, consent, visible, state, setEnabled,
        clockedIn: !!verifiedShift, verifying: status.isFetching, verificationError: status.isError }}>{children}</AutoDrivingContext.Provider>;
}

export function AutoDrivingStatus() {
    const context = useContext(AutoDrivingContext);
    if (!context?.eligible) return null;
    const { consent, visible, state, setEnabled, clockedIn, verificationError } = context;
    const label = !consent ? 'Enable automatic work mileage' : !visible ? 'Mileage paused while the app is hidden'
        : verificationError ? 'Mileage paused: work shift could not be verified' : !clockedIn ? 'Automatic mileage ready for your next clock-in'
            : state.lastObserved ? 'Recording GPS work mileage' : 'Waiting for GPS work mileage';
    return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#111] px-4 py-3 text-white">
        <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-xs font-semibold"><Car className="h-4 w-4 text-yellow-400" />{label}</p>
            <p className="mt-1 text-[11px] text-gray-400">{!consent
                ? 'Allow GPS mileage collection during clocked-in shifts on this device. Your manager sees measured driving miles and coverage. You can turn it off anytime.'
                : state.error || 'Keep the app visible and location allowed. Hidden or locked screens, GPS gaps, and slow movement can leave partial coverage. No mileage is estimated.'}</p>
            {!!state.queued_batches && <p className="mt-1 text-[10px] text-amber-300">{state.queued_batches} GPS batch(es) waiting to sync on this device.</p>}
        </div>
        <button type="button" className="min-h-10 rounded-lg border border-white/20 px-3 text-xs font-bold hover:bg-white/10"
            aria-pressed={consent} onClick={() => setEnabled(!consent)}>{consent ? 'Turn off mileage' : 'Enable GPS mileage'}</button>
    </div>;
}
