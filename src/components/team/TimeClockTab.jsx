import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Download, LogIn, LogOut, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { clockPresetDates, clockDateRangeInZone, durationLabel, shiftMilliseconds, summarizeTimeClock, DEFAULT_CLOCK_TIMEZONE,
    clockInputValue, clockInputInstant, downloadTimesheetCsv } from '@/lib/timeClock';

const panel = 'rounded-xl border border-gray-800 bg-[#111] p-4 md:p-5';
const selectStyle = 'h-10 w-full rounded-md border border-gray-700 bg-black px-3 text-sm text-white';
const errorMessage = error => error?.response?.data?.error || error?.message || 'Unable to load the time clock.';
const actionLabels = { close_shift: 'Close shift', edit_shift: 'Edit times', add_shift: 'Add missing shift', request_correction: 'Request correction' };
const isLong = (shift, now) => shift.status === 'active' && shiftMilliseconds(shift, now) >= 12 * 3600000;

function ShiftDetails({ shift, serverNow, range, timestamp, canManage, ready, openEditor }) {
    const requests = (shift.correction_requests || []).filter(value => value.status === 'pending');
    return <article className="space-y-2 rounded-lg border border-gray-800 bg-black/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">{shift.status === 'active' ? 'Open shift' : durationLabel(shiftMilliseconds(shift, serverNow, range))}
                {shift.adjusted && <span className="ml-2 text-xs text-amber-300">Adjusted</span>}
                {isLong(shift, serverNow) && <span className="ml-2 text-xs text-amber-300">Needs review</span>}</p>
            <Button size="sm" variant="outline" className="border-gray-700 bg-black" disabled={!ready}
                onClick={() => openEditor(canManage ? 'edit_shift' : 'request_correction', shift)}>{canManage ? 'Edit times' : 'Request correction'}</Button>
        </div>
        <p className="text-xs text-gray-400">Start: {timestamp(shift.clock_in_at)} · Finish: {timestamp(shift.clock_out_at)}</p>
        {shift.closed_by && shift.closed_by !== shift.rep_user_id && <p className="text-xs text-gray-500">Closed by manager</p>}
        {requests.map(request => <p key={request.request_id} className="text-xs text-amber-300">Correction requested: {request.reason} · {timestamp(request.start_at)} → {timestamp(request.end_at)}</p>)}
        {(shift.audit_trail || []).length > 0 && <details className="text-xs text-gray-400">
            <summary className="cursor-pointer">Adjustment history · {shift.audit_trail.length}</summary>
            <div className="mt-2 space-y-3">{shift.audit_trail.map(change => <div key={change.request_id}>
                <p>{change.actor_name || change.actor_id} · {timestamp(change.at)}</p><p>{change.reason}</p>
                <p>Original: {change.before_start ? timestamp(change.before_start) : 'Missing shift'} → {change.before_end ? timestamp(change.before_end) : 'Open'}</p>
                <p>Recorded: {timestamp(change.after_start)} → {timestamp(change.after_end)}</p>
            </div>)}</div>
        </details>}
    </article>;
}

export default function TimeClockTab({ currentUser, managerId, canManage, activeTeamCode = 'all' }) {
    const queryClient = useQueryClient();
    const [timezone, setTimezone] = useState(currentUser?.time_clock_timezone || DEFAULT_CLOCK_TIMEZONE);
    const [preset, setPreset] = useState('this-week');
    const [customDates, setCustomDates] = useState(() => clockPresetDates('this-week'));
    const [person, setPerson] = useState('all');
    const [selectedPersonName, setSelectedPersonName] = useState('');
    const [editing, setEditing] = useState(null);
    const [form, setForm] = useState({ person_id: '', start: '', end: '', reason: '' });
    const [exportOpen, setExportOpen] = useState(false);
    const [exportFormat, setExportFormat] = useState('totals');
    const [now, setNow] = useState(Date.now());
    const [online, setOnline] = useState(() => navigator.onLine);
    const clockInRequest = useRef(null);
    const dates = preset === 'custom' ? customDates : clockPresetDates(preset, now, timezone);
    const datesValid = useMemo(() => {
        try { clockDateRangeInZone(dates.start, dates.end, timezone); return true; }
        catch { return false; }
    }, [dates.start, dates.end, timezone]);
    const queryKey = ['timeClock', managerId, currentUser?.id, dates.start, dates.end, timezone];
    const statusKey = ['timeClock', managerId, currentUser?.id, 'status'];
    const status = useQuery({
        queryKey: statusKey,
        queryFn: async () => {
            const response = await base44.functions.invoke('timeClock', { action: 'status' });
            if (!response.data?.success || response.data.manager_id !== managerId) throw new Error('Time clock status could not be verified.');
            return response.data;
        },
        enabled: !!managerId && !!currentUser?.id,
        refetchInterval: 5000,
        refetchIntervalInBackground: false,
        retry: 1,
    });
    const query = useQuery({
        queryKey,
        queryFn: async () => {
            const response = await base44.functions.invoke('timeClock', { action: 'report',
                start_date: dates.start, end_date: dates.end });
            if (!response.data?.success || response.data.manager_id !== managerId) throw new Error('Time clock records could not be verified.');
            return response.data;
        },
        enabled: !!managerId && !!currentUser?.id && datesValid,
        refetchInterval: 5000,
        refetchIntervalInBackground: false,
        retry: 1,
    });
    useEffect(() => { if (status.data?.timezone) setTimezone(status.data.timezone); }, [status.data?.timezone]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        const onOnline = () => { setOnline(true); queryClient.invalidateQueries({ queryKey: ['timeClock'] }); };
        const onOffline = () => setOnline(false);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => { clearInterval(timer); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
    }, [queryClient]);
    useEffect(() => { setPerson('all'); setEditing(null); setExportOpen(false); }, [activeTeamCode, managerId, currentUser?.id]);
    const mutation = useMutation({
        mutationFn: async payload => {
            const response = await base44.functions.invoke('timeClock', payload);
            if (!response.data?.success) throw new Error('Time clock update could not be verified.');
            return response.data;
        },
        onSuccess: (data, payload) => {
            clockInRequest.current = null;
            setEditing(null);
            if (payload.action === 'set_timezone') {
                setTimezone(data.timezone);
                toast.success('Reporting timezone saved');
                return;
            }
            queryClient.setQueryData(statusKey, previous => previous ? {
                ...previous,
                ...(data.shift.rep_user_id === currentUser?.id && (payload.action === 'clock_in' || previous.current_shift?.id === data.shift.id)
                    ? { current_shift: data.shift.status === 'active' ? data.shift : null } : {}),
            } : previous);
            toast.success(payload.action === 'clock_in' ? (data.shift.status === 'active' ? 'Clocked in' : 'Shift already completed')
                : payload.action === 'clock_out' ? 'Clocked out'
                : payload.action === 'request_correction' ? 'Correction requested' : 'Times saved');
        },
        onError: error => toast.error(errorMessage(error)),
        onSettled: () => queryClient.invalidateQueries({ queryKey: ['timeClock'] }),
    });
    useEffect(() => {
        if (status.isSuccess && !status.isFetching && !mutation.isPending) clockInRequest.current = null;
    }, [status.dataUpdatedAt, status.isSuccess, status.isFetching, mutation.isPending]);
    const offset = status.data?.server_time ? Date.parse(status.data.server_time) - status.dataUpdatedAt : 0;
    const serverNow = now + offset;
    const timestamp = value => value ? new Date(value).toLocaleString([], {
        timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
    }) : 'Open';
    const current = status.data?.current_shift;
    const canClock = status.data?.can_clock === true;
    const teamFilter = shift => !canManage || activeTeamCode === 'all' || shift.rep_user_id === managerId || shift.invite_code === activeTeamCode;
    const history = datesValid ? (query.data?.shifts || []).filter(teamFilter) : [];
    // The live roster is the entire current team, independent of every timesheet filter.
    const active = status.data?.active_shifts || [];
    const people = [...new Map([...(status.data?.people || []), ...(query.data?.people || [])].map(value => [value.id, value])).values()]
        .filter(value => !canManage || activeTeamCode === 'all' || value.id === managerId || value.invite_code === activeTeamCode);
    // Retain a selected former member when a different range contains none of their shifts.
    if (person !== 'all' && !people.some(value => value.id === person)) people.push({ id: person, name: selectedPersonName || 'Selected team member', can_add: false });
    const selectedPeople = people.filter(value => !canManage || person === 'all' || value.id === person);
    const displayed = history.filter(shift => !canManage || person === 'all' || shift.rep_user_id === person);
    const range = query.data?.range;
    const summaries = range && datesValid ? summarizeTimeClock(displayed, range, serverNow, selectedPeople) : [];
    const total = summaries.reduce((sum, group) => sum + group.completed_ms, 0);
    const openCount = summaries.reduce((sum, group) => sum + group.open_shifts, 0);
    const ready = online && !!status.data && !status.isError && !status.isFetching && !mutation.isPending;
    const exportReady = ready && datesValid && !!range && !query.isError && !query.isFetching && summaries.length > 0;
    const timezones = useMemo(() => [...new Set([DEFAULT_CLOCK_TIMEZONE, timezone,
        ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'])])].sort(), [timezone]);

    function clockIn() {
        if (!clockInRequest.current) clockInRequest.current = crypto.randomUUID();
        mutation.mutate({ action: 'clock_in', request_id: clockInRequest.current });
    }
    function openEditor(action, shift = null) {
        const request = canManage ? shift?.correction_requests?.find(value => value.status === 'pending') : null;
        setForm({
            person_id: shift?.rep_user_id || selectedPeople.find(value => value.can_add)?.id || managerId,
            start: clockInputValue(request?.start_at || shift?.clock_in_at || new Date(serverNow - 3600000).toISOString(), timezone),
            end: clockInputValue(request?.end_at || shift?.clock_out_at || new Date(serverNow).toISOString(), timezone),
            reason: request?.reason || '',
        });
        mutation.reset();
        setEditing({ action, shift, request_id: crypto.randomUUID() });
    }
    function saveEdit(event) {
        event.preventDefault();
        try {
            const start_at = clockInputInstant(form.start, timezone, editing.shift?.clock_in_at);
            const end_at = clockInputInstant(form.end, timezone, editing.shift?.clock_out_at);
            mutation.mutate({ action: editing.action, request_id: editing.request_id, shift_id: editing.shift?.id,
                person_id: form.person_id, start_at, end_at, reason: form.reason, revision: editing.shift?.revision || 0 });
        } catch (error) { toast.error(error.message); }
    }
    const detailProps = { serverNow, range, timestamp, canManage, ready, openEditor };
    return <div className="space-y-4 text-white">
        <section className={`${panel} flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`}>
            <div>
                <h2 className="flex items-center gap-2 text-lg font-bold"><Clock3 className="h-5 w-5 text-yellow-500" />Your shift</h2>
                {status.data && <p className={`mt-3 text-base font-semibold ${current ? 'text-green-400' : 'text-gray-300'}`}>
                    {current ? `Clocked in · ${durationLabel(shiftMilliseconds(current, serverNow))}` : 'Clocked out'}
                </p>}
                {current ? <p className="mt-1 text-xs text-gray-400">Started {timestamp(current.clock_in_at)}</p>
                    : status.data && <p className="mt-1 text-xs text-gray-400">{durationLabel(status.data.completed_today_ms || 0)} completed today</p>}
            </div>
            {canClock && <Button onClick={current ? () => mutation.mutate({ action: 'clock_out', shift_id: current.id }) : clockIn}
                disabled={!ready} className={`min-h-12 shrink-0 font-bold ${current ? 'border border-red-400/40 bg-red-500/15 text-red-200 hover:bg-red-500/25' : 'bg-yellow-500 text-black hover:bg-yellow-400'}`}>
                {current ? <LogOut className="mr-2 h-4 w-4" /> : <LogIn className="mr-2 h-4 w-4" />}
                {mutation.isPending && ['clock_in', 'clock_out'].includes(mutation.variables?.action) ? 'Saving…' : current ? 'Clock out' : 'Clock in'}
            </Button>}
        </section>
        {!online && <p role="alert" className="text-sm text-amber-300">Offline · Reconnect to save clock actions.</p>}
        {status.isPending && <p role="status" className="text-sm text-gray-400">Loading time clock…</p>}
        {(status.isError || query.isError || mutation.isError) && <div role="alert" className={`${panel} text-sm text-amber-300`}>
            {errorMessage(status.error || query.error || mutation.error)} <button type="button" className="ml-2 underline" onClick={() => { mutation.reset(); status.refetch(); query.refetch(); }}>Refresh status</button>
        </div>}
        {canManage && <section className={`${panel} space-y-3`} aria-label="Clocked in now">
            <div className="flex items-center justify-between gap-2">
                <h3 className="font-bold">Clocked in now{status.data ? ` · ${active.length}` : ''}</h3>
                <Button size="sm" variant="outline" className="border-gray-700 bg-black" disabled={!online || status.isFetching} onClick={() => status.refetch()} aria-label="Refresh time clock"><RefreshCw className={`h-4 w-4 ${status.isFetching ? 'animate-spin' : ''}`} /></Button>
            </div>
            {status.data && active.length === 0 && <p className="text-sm text-gray-400">No one is clocked in.</p>}
            {active.map(shift => <div key={shift.id} className="flex items-center justify-between gap-3 border-t border-gray-800 pt-3">
                <div className="min-w-0"><p className="text-sm font-semibold">{shift.rep_name || shift.rep_email || 'Team member'}{shift.rep_user_id === currentUser?.id && <span className="ml-2 text-xs text-gray-400">You</span>}</p>
                    <p className="mt-1 text-xs text-gray-400">Started {timestamp(shift.clock_in_at)}</p>
                    {isLong(shift, serverNow) && <p className="mt-1 text-xs text-amber-300">Needs review</p>}</div>
                <div className="flex shrink-0 items-center gap-2"><span className="text-sm font-semibold text-green-400">{durationLabel(shiftMilliseconds(shift, serverNow))}</span>
                    <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" disabled={!ready} aria-label={`Manage shift for ${shift.rep_name || 'team member'}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent className="border-gray-800 bg-[#111] text-white">
                            <DropdownMenuItem onSelect={() => openEditor('close_shift', shift)}>Close shift</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => openEditor('edit_shift', shift)}>Edit times</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>)}
        </section>}
        <section className={`${panel} space-y-4`} aria-label="Timesheets">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-bold">Timesheets</h3>
                <div className="flex gap-2">
                    {canManage && <Button size="sm" variant="outline" className="border-gray-700 bg-black" disabled={!ready} onClick={() => openEditor('add_shift')}><Plus className="mr-1 h-4 w-4" />Add shift</Button>}
                    <Button size="sm" variant="outline" className="border-gray-700 bg-black" disabled={!exportReady} onClick={() => setExportOpen(true)}><Download className="mr-1 h-4 w-4" />Export</Button>
                </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-gray-400">Date range<select className={`mt-1 ${selectStyle}`} value={preset} onChange={event => {
                    setCustomDates(dates); setPreset(event.target.value);
                }}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="this-week">This week</option><option value="last-week">Last week</option><option value="custom">Custom dates</option></select></label>
                {canManage && <label className="text-xs text-gray-400">People<select className={`mt-1 ${selectStyle}`} value={person} onChange={event => {
                    setSelectedPersonName(people.find(value => value.id === event.target.value)?.name || ''); setPerson(event.target.value);
                }}><option value="all">All team members</option>{people.map(value => <option key={value.id} value={value.id}>{value.name}{value.id === currentUser?.id ? ' (You)' : ''}</option>)}</select></label>}
            </div>
            {preset === 'custom' && <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-gray-400">From<Input type="date" className="mt-1 border-gray-700 bg-black text-white" value={customDates.start} onChange={event => setCustomDates(value => ({ ...value, start: event.target.value }))} /></label>
                <label className="text-xs text-gray-400">Through<Input type="date" className="mt-1 border-gray-700 bg-black text-white" value={customDates.end} onChange={event => setCustomDates(value => ({ ...value, end: event.target.value }))} /></label>
            </div>}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-400">
                <p>{dates.start} – {dates.end}</p>
                {canManage ? <label className="flex max-w-full items-center gap-2">Reporting timezone<select aria-label="Reporting timezone" className="min-w-0 max-w-64 rounded border border-gray-700 bg-black p-1 text-gray-300" value={timezone} disabled={!ready}
                    onChange={event => mutation.mutate({ action: 'set_timezone', timezone: event.target.value })}>{timezones.map(value => <option key={value}>{value}</option>)}</select></label>
                    : <p>Reporting timezone: {timezone}</p>}
            </div>
            {!datesValid && <p role="alert" className="text-xs text-amber-300">Choose a valid date range.</p>}
            {query.data && datesValid && <div className="rounded-lg bg-white/5 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-xs text-gray-400">Completed hours</p>{openCount > 0 && <p className="text-xs text-amber-300">Open shifts excluded · {openCount}</p>}</div>
                <p className="mt-1 text-xl font-bold">{durationLabel(total)}</p>
            </div>}
            {canManage && summaries.length > 0 && <div className="hidden grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-3 text-xs text-gray-500 sm:grid"><span>Person</span><span>Completed hours</span><span>Completed shifts</span><span>Attention needed</span></div>}
            {canManage ? summaries.map(group => <details key={group.id} className="rounded-lg border border-gray-800">
                <summary className="grid cursor-pointer list-none gap-2 p-3 sm:grid-cols-[2fr_1fr_1fr_1fr] sm:items-center">
                    <span className="text-sm font-semibold">{group.name}{group.id === currentUser?.id && <span className="ml-2 text-xs text-gray-400">You</span>} <span className="text-gray-500">⌄</span></span>
                    <span className="text-sm font-semibold"><span className="mr-1 text-xs font-normal text-gray-500 sm:hidden">Completed hours</span>{durationLabel(group.completed_ms)}</span>
                    <span className="text-xs text-gray-400">{group.completed_shifts} <span className="sm:hidden">completed shifts</span></span>
                    <span className={`text-xs ${group.open_shifts || group.requests ? 'text-amber-300' : 'text-gray-500'}`}>{[group.open_shifts ? `${group.open_shifts} open` : '', group.requests ? `${group.requests} correction${group.requests === 1 ? '' : 's'}` : '',
                        group.shifts.some(shift => isLong(shift, serverNow)) ? 'Needs review' : ''].filter(Boolean).join(' · ') || '—'}</span>
                </summary>
                <div className="space-y-3 border-t border-gray-800 p-3">{group.shifts.length ? group.shifts.map(shift => <ShiftDetails key={shift.id} shift={shift} {...detailProps} />) : <p className="text-sm text-gray-400">No shifts in these dates.</p>}</div>
            </details>) : displayed.map(shift => <ShiftDetails key={shift.id} shift={shift} {...detailProps} />)}
            {query.data && datesValid && displayed.length === 0 && !canManage && <p className="text-sm text-gray-400">No shifts in these dates.</p>}
        </section>
        <Dialog open={!!editing} onOpenChange={open => { if (!open && !mutation.isPending) setEditing(null); }}>
            <DialogContent className="max-h-[90vh] overflow-y-auto border-gray-800 bg-[#111] text-white">
                <DialogHeader><DialogTitle>{actionLabels[editing?.action]}{editing?.shift ? ` · ${editing.shift.rep_name || 'Team member'}` : ''}</DialogTitle><DialogDescription className="text-gray-400">{timezone}</DialogDescription></DialogHeader>
                <form onSubmit={saveEdit} className="space-y-4">
                    {editing?.action === 'add_shift' && <label className="block text-xs text-gray-400">Person<select required className={`mt-1 ${selectStyle}`} value={form.person_id} onChange={event => setForm(value => ({ ...value, person_id: event.target.value }))}>{people.filter(value => value.can_add).map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
                    <label className="block text-xs text-gray-400">Start<Input required type="datetime-local" step="1" disabled={editing?.action === 'close_shift'} className="mt-1 border-gray-700 bg-black text-white" value={form.start} onChange={event => setForm(value => ({ ...value, start: event.target.value }))} /></label>
                    <label className="block text-xs text-gray-400">Actual finish<Input required type="datetime-local" step="1" className="mt-1 border-gray-700 bg-black text-white" value={form.end} onChange={event => setForm(value => ({ ...value, end: event.target.value }))} /></label>
                    <label className="block text-xs text-gray-400">Reason<textarea required maxLength={1000} className="mt-1 min-h-20 w-full rounded-md border border-gray-700 bg-black p-3 text-sm text-white" value={form.reason} onChange={event => setForm(value => ({ ...value, reason: event.target.value }))} /></label>
                    {mutation.isError && <p role="alert" className="text-sm text-amber-300">{errorMessage(mutation.error)}</p>}
                    <Button type="submit" disabled={!ready} className="w-full bg-yellow-500 text-black hover:bg-yellow-400">{mutation.isPending ? 'Saving…' : editing?.action === 'request_correction' ? 'Send request' : 'Save times'}</Button>
                </form>
            </DialogContent>
        </Dialog>
        <Dialog open={exportOpen} onOpenChange={setExportOpen}>
            <DialogContent className="border-gray-800 bg-[#111] text-white">
                <DialogHeader><DialogTitle>Export timesheets</DialogTitle><DialogDescription className="text-gray-400">{dates.start} – {dates.end} · {timezone}</DialogDescription></DialogHeader>
                <p className="text-sm">{canManage && person === 'all' ? `All team members · ${selectedPeople.length} people` : selectedPeople.map(value => value.name).join(', ')}</p>
                <p className="text-xs text-gray-400">{durationLabel(total)} completed · {openCount} open shifts excluded from completed hours</p>
                <label className="text-xs text-gray-400">CSV report<select className={`mt-1 ${selectStyle}`} value={exportFormat} onChange={event => setExportFormat(event.target.value)}><option value="totals">Totals by person</option><option value="details">Shift details</option></select></label>
                <Button disabled={!exportReady} className="bg-yellow-500 text-black hover:bg-yellow-400" onClick={() => {
                    downloadTimesheetCsv(displayed, range, serverNow, timezone, exportFormat, selectedPeople, dates.start, dates.end); setExportOpen(false);
                }}>Download CSV</Button>
            </DialogContent>
        </Dialog>
    </div>;
}
