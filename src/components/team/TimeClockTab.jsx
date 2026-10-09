import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Download, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { clockDateRange, localClockDate, durationLabel, shiftMilliseconds, downloadTimeClockCsv } from '@/lib/timeClock';

const panel = 'rounded-xl border border-gray-800 bg-[#111] p-4 md:p-5';
const timestamp = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Still clocked in';
const errorMessage = error => error?.response?.data?.error || error?.message || 'Unable to load the time clock.';

export default function TimeClockTab({ currentUser, managerId, canManage, activeTeamCode = 'all' }) {
    const queryClient = useQueryClient();
    const [start, setStart] = useState(() => localClockDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
    const [end, setEnd] = useState(() => localClockDate());
    const [person, setPerson] = useState('all');
    const [closing, setClosing] = useState(null);
    const [now, setNow] = useState(Date.now());
    const [online, setOnline] = useState(() => navigator.onLine);
    const clockInRequest = useRef(null);
    const range = useMemo(() => clockDateRange(start, end), [start, end]);
    // Invalid history filters must not prevent a canvasser from ending a shift.
    const fetchRange = range || clockDateRange(localClockDate(), localClockDate());
    const queryKey = ['timeClock', managerId, currentUser?.id, fetchRange.start_at, fetchRange.end_at];
    const query = useQuery({
        queryKey,
        queryFn: async () => {
            const response = await base44.functions.invoke('timeClock', { action: 'report', start_at: fetchRange.start_at, end_at: fetchRange.end_at });
            if (!response.data?.success || response.data.manager_id !== managerId) throw new Error('Time clock records could not be verified.');
            return response.data;
        },
        enabled: !!managerId && !!currentUser?.id,
        refetchInterval: 15000,
        refetchIntervalInBackground: false,
        retry: 1,
    });
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        const onOnline = () => { setOnline(true); queryClient.invalidateQueries({ queryKey: ['timeClock'] }); };
        const onOffline = () => setOnline(false);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => { clearInterval(timer); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
    }, [queryClient]);
    useEffect(() => { setPerson('all'); }, [activeTeamCode, managerId]);
    const mutation = useMutation({
        mutationFn: async payload => {
            const response = await base44.functions.invoke('timeClock', payload);
            if (!response.data?.success) throw new Error('Time clock update could not be verified.');
            return response.data;
        },
        onSuccess: (data, payload) => {
            clockInRequest.current = null;
            setClosing(null);
            // Update immediately, then reload history and team status from the server.
            queryClient.setQueryData(queryKey, previous => previous ? {
                ...previous,
                ...(data.shift.rep_user_id === currentUser?.id ? { current_shift: data.shift.status === 'active' ? data.shift : null } : {}),
            } : previous);
            toast.success(payload.action === 'clock_in' && data.shift.status === 'active' ? 'Clocked in' : 'Clocked out');
        },
        onError: error => toast.error(errorMessage(error)),
        onSettled: () => queryClient.invalidateQueries({ queryKey: ['timeClock'] }),
    });
    // After a verified refresh, the next deliberate clock-in starts a new request.
    // Until then retain the key so an uncertain response can be retried safely.
    useEffect(() => {
        if (query.isSuccess && !query.isFetching && !mutation.isPending) clockInRequest.current = null;
    }, [query.dataUpdatedAt, query.isSuccess, query.isFetching, mutation.isPending]);
    const offset = query.data?.server_time ? Date.parse(query.data.server_time) - query.dataUpdatedAt : 0;
    const serverNow = now + offset;
    const current = query.data?.current_shift;
    const canClock = query.data?.can_clock === true;
    const teamFilter = shift => !canManage || activeTeamCode === 'all' || shift.invite_code === activeTeamCode;
    const history = range ? (query.data?.shifts || []).filter(teamFilter) : [];
    const active = (query.data?.active_shifts || []).filter(teamFilter);
    const people = [...new Map([...history, ...active].map(shift => [shift.rep_user_id, shift.rep_name || shift.rep_email || 'Rep'])).entries()];
    const displayed = history.filter(shift => person === 'all' || shift.rep_user_id === person);
    const activeDisplayed = active.filter(shift => person === 'all' || shift.rep_user_id === person);
    const total = displayed.reduce((sum, shift) => sum + shiftMilliseconds(shift, serverNow, range), 0);
    const ready = online && !!query.data && !query.isError && !query.isFetching && !mutation.isPending;
    const exportReady = ready && !!range && displayed.length > 0;
    function clockIn() {
        if (!clockInRequest.current) clockInRequest.current = crypto.randomUUID();
        mutation.mutate({ action: 'clock_in', request_id: clockInRequest.current });
    }
    function closeOwnShift() {
        mutation.mutate({ action: 'clock_out', shift_id: current.id });
    }
    return <div className="space-y-4 text-white">
        <section className={`${panel} flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`}>
            <div>
                <h2 className="flex items-center gap-2 text-lg font-bold"><Clock3 className="h-5 w-5 text-yellow-500" />Time Clock</h2>
                <p className="mt-1 text-xs text-gray-400">Clock in when you start canvassing and clock out when you finish. Your shift stays open when you leave the app.</p>
                {query.data && canClock && <p className={`mt-3 text-sm font-semibold ${current ? 'text-green-400' : 'text-gray-300'}`}>
                    {current ? `Clocked in · ${durationLabel(shiftMilliseconds(current, serverNow))} elapsed` : 'You are clocked out'}
                </p>}
                {current && <p className="mt-1 text-xs text-gray-400">Started {timestamp(current.clock_in_at)}</p>}
                {query.data && !canClock && <p className="mt-3 text-xs text-gray-400">Canvassers clock in and out here. Managers review hours and can close forgotten team shifts below.</p>}
            </div>
            {canClock && <Button onClick={current ? closeOwnShift : clockIn} disabled={!ready} className={`min-h-12 shrink-0 font-bold ${current ? 'border border-red-400/40 bg-red-500/15 text-red-200 hover:bg-red-500/25' : 'bg-yellow-500 text-black hover:bg-yellow-400'}`}>
                {current ? <LogOut className="mr-2 h-4 w-4" /> : <LogIn className="mr-2 h-4 w-4" />}
                {mutation.isPending ? 'Saving…' : current ? 'Clock Out' : 'Clock In'}
            </Button>}
        </section>
        {!online && <p role="alert" className="text-sm text-amber-300">Connect to the internet to clock in or out. Your saved shift continues while offline.</p>}
        {query.isPending && <p role="status" className="text-sm text-gray-400">Loading time clock…</p>}
        {(query.isError || mutation.isError) && <div role="alert" className={`${panel} text-sm text-amber-300`}>
            {errorMessage(query.error || mutation.error)} <button type="button" className="ml-2 underline" onClick={() => { mutation.reset(); query.refetch(); }}>Refresh status</button>
        </div>}
        <section className={`${panel} space-y-4`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h3 className="font-bold">{canManage ? 'Team hours' : 'My hours'}</h3><p className="mt-1 text-xs text-gray-400">Times use your device’s timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Hours include only time inside the selected dates.</p></div>
                <div className="flex gap-2">
                    <Button variant="outline" className="border-gray-700 bg-black" disabled={!online || query.isFetching} onClick={() => query.refetch()} aria-label="Refresh time clock"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></Button>
                    <Button variant="outline" className="border-gray-700 bg-black" disabled={!exportReady} onClick={() => downloadTimeClockCsv(displayed, range, serverNow, start, end)}><Download className="mr-2 h-4 w-4" />Export CSV</Button>
                </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs text-gray-400">From<Input type="date" className="mt-1 border-gray-700 bg-black text-white" value={start} onChange={event => setStart(event.target.value)} /></label>
                <label className="text-xs text-gray-400">Through<Input type="date" className="mt-1 border-gray-700 bg-black text-white" value={end} onChange={event => setEnd(event.target.value)} /></label>
                {canManage && <label className="text-xs text-gray-400">Team member<select className="mt-1 h-10 w-full rounded-md border border-gray-700 bg-black px-3 text-white" value={person} onChange={event => setPerson(event.target.value)}><option value="all">All team members</option>{people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>}
            </div>
            {!range && <p role="alert" className="text-xs text-amber-300">Choose a valid date range of up to one year.</p>}
            {query.data && <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-white/5 p-3"><p className="text-xs text-gray-400">Hours in selected dates</p><p className="mt-1 text-xl font-bold">{durationLabel(total)}</p></div><div className="rounded-lg bg-white/5 p-3"><p className="text-xs text-gray-400">Clocked in now</p><p className="mt-1 text-xl font-bold text-green-400">{activeDisplayed.length}</p></div></div>}
        </section>
        {query.data && activeDisplayed.length > 0 && <section className={`${panel} space-y-3`}>
            <h3 className="font-bold">Currently clocked in</h3>
            {activeDisplayed.map(shift => <div key={shift.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 pt-3">
                <div><p className="text-sm font-semibold">{shift.rep_name || 'Rep'} <span className="text-green-400">· {durationLabel(shiftMilliseconds(shift, serverNow))}</span></p><p className="mt-1 text-xs text-gray-400">Since {timestamp(shift.clock_in_at)}</p></div>
                {canManage && shift.rep_user_id !== currentUser?.id && <Button variant="outline" className="border-gray-700 bg-black" disabled={!ready} onClick={() => setClosing(shift)}>Clock out member</Button>}
            </div>)}
        </section>}
        <section className={`${panel} space-y-3`}>
            <h3 className="font-bold">Shift history</h3>
            {query.data && range && displayed.length === 0 && <p className="text-sm text-gray-400">No shifts in these dates.</p>}
            {displayed.map(shift => <article key={shift.id} className="grid gap-2 border-t border-gray-800 pt-3 sm:grid-cols-[1fr_2fr_auto]">
                <div><p className="text-sm font-semibold">{shift.rep_name || 'Rep'}</p><p className="text-xs text-gray-500">{shift.status === 'active' ? 'Clocked in' : 'Completed'}{shift.closed_by && shift.closed_by !== shift.rep_user_id ? ' · Closed by manager' : ''}</p></div>
                <div className="text-xs text-gray-400"><p>In: {timestamp(shift.clock_in_at)}</p><p className="mt-1">Out: {timestamp(shift.clock_out_at)}</p></div>
                <p className="text-sm font-semibold">{durationLabel(shiftMilliseconds(shift, serverNow, range))}</p>
            </article>)}
        </section>
        <Dialog open={!!closing} onOpenChange={open => { if (!open && !mutation.isPending) setClosing(null); }}>
            <DialogContent className="border-gray-800 bg-[#111] text-white">
                <DialogHeader><DialogTitle>Clock out {closing?.rep_name || 'team member'}?</DialogTitle><DialogDescription className="text-gray-400">This ends their shift at the current time and records that you closed it.</DialogDescription></DialogHeader>
                <Button disabled={!ready} className="bg-yellow-500 text-black hover:bg-yellow-400" onClick={() => mutation.mutate({ action: 'close_shift', shift_id: closing.id })}>{mutation.isPending ? 'Saving…' : 'Clock out member'}</Button>
            </DialogContent>
        </Dialog>
    </div>;
}

