import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, Download, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { downloadDrivingCsv, drivingTotals, localDrivingDate, tripMiles, tripPayment } from '@/lib/drivingAccounting';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const panel = 'rounded-xl border border-gray-800 bg-[#111] p-4 md:p-5';
const field = 'bg-black border-gray-700 text-white';
const statusColors = { submitted: 'text-yellow-400', approved: 'text-blue-400', paid: 'text-green-400', rejected: 'text-red-400', cancelled: 'text-gray-500' };
const matchesMember = (trip, member) => member.isTeamManager
    ? trip.rep_user_id === member.user_id : trip.member_id === member.id || (!!member.user_id && trip.rep_user_id === member.user_id);

function FormField({ label, children }) {
    return <label className="grid gap-1.5 text-xs text-gray-400">{label}{children}</label>;
}
function Totals({ trips }) {
    const totals = drivingTotals(trips);
    return <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
            ['Recorded business miles', `${totals.miles.toFixed(1)} mi`, `${totals.trips} trips · excludes rejected / cancelled`],
            ['Awaiting review', `${totals.submitted_miles.toFixed(1)} mi`, `${totals.approved_miles.toFixed(1)} mi approved (includes paid)`],
            ['Approved, unpaid', money(totals.due_cents), 'Approved trips awaiting reimbursement'],
            ['Reimbursed', money(totals.paid_cents), 'Trips marked paid'],
        ].map(([label, value, hint]) => <div className={panel} key={label}><p className="text-xs text-gray-400">{label}</p><p className="mt-2 text-xl md:text-2xl font-bold text-white">{value}</p><p className="mt-1 text-[10px] text-gray-500">{hint}</p></div>)}
    </div>;
}

export default function DrivingTab({ members, currentUser, managerId, canManage, allTeams = true, teamLoading = false }) {
    const queryClient = useQueryClient();
    const [start, setStart] = useState(() => localDrivingDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
    const [end, setEnd] = useState(() => localDrivingDate());
    const [selected, setSelected] = useState('all');
    const [rate, setRate] = useState('');
    const [form, setForm] = useState(null);
    const [review, setReview] = useState(null);
    const [reviewText, setReviewText] = useState('');
    const validRange = !!start && !!end && start <= end;
    const query = useQuery({
        queryKey: ['drivingTrips', managerId, currentUser?.id, start, end],
        enabled: !!managerId && !!currentUser?.id && validRange,
        queryFn: async () => {
            const res = await base44.functions.invoke('drivingAccounting', { action: 'report', start_date: start, end_date: end });
            if (!res.data?.success || res.data.manager_id !== managerId) throw new Error('Driving records could not be verified.');
            return res.data.trips;
        },
    });
    const mutation = useMutation({
        mutationFn: async payload => {
            const res = await base44.functions.invoke('drivingAccounting', payload);
            if (!res.data?.success) throw new Error('Unable to save driving record.');
            return res.data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: ['drivingTrips'] });
            setForm(null); setReview(null); setReviewText('');
            toast.success(variables.action === 'submit' ? 'Trip submitted for review' : variables.action === 'pay' ? 'Trip marked paid' : 'Driving record updated');
        },
        onError: error => toast.error(error?.response?.data?.error || error.message || 'Unable to save driving record.'),
    });
    const trips = useMemo(() => (query.data || []).filter(t => !canManage || allTeams || members.some(m => matchesMember(t, m))), [query.data, canManage, allTeams, members]);
    const people = useMemo(() => {
        const rows = members.filter(m => canManage || m.user_id === currentUser?.id).map(m => ({ ...m, drivingId: m.isTeamManager ? managerId : m.id }));
        if (allTeams) for (const trip of trips) {
            if (!rows.some(m => matchesMember(trip, m))) rows.push({ id: trip.member_id, drivingId: trip.member_id, user_id: trip.rep_user_id, name: trip.rep_name, status: 'inactive' });
        }
        return rows;
    }, [members, canManage, currentUser?.id, managerId, trips, allTeams]);
    const chosenPerson = people.find(m => m.drivingId === selected);
    const displayedTrips = selected === 'all' ? trips : chosenPerson ? trips.filter(t => matchesMember(t, chosenPerson)) : [];
    const ready = validRange && !query.isFetching && !query.isError && !!query.data && !teamLoading;
    const eligiblePeople = people.filter(m => m.status !== 'inactive');
    let preview = '';
    if (form?.odometer_start !== '' && form?.odometer_end !== '' && form) {
        try { preview = `${tripMiles(form.odometer_start, form.odometer_end).miles.toFixed(1)} business miles`; } catch { preview = 'Ending odometer must exceed starting odometer; use up to one decimal.'; }
    }
    let approvalPreview = '';
    if (review?.action === 'approve') {
        try { approvalPreview = money(tripPayment(review.trip.miles, rate).reimbursement_cents); } catch { /* Rate validation appears on submit. */ }
    }
    function openForm() {
        setForm({ member_id: eligiblePeople[0]?.drivingId || '', trip_date: localDrivingDate(), origin: '', destination: '', purpose: '', vehicle: '', odometer_start: '', odometer_end: '', notes: '', submission_id: crypto.randomUUID() });
    }
    function updateForm(key, value) { setForm(previous => ({ ...previous, [key]: value })); }
    function openReview(action, trip) { setReview({ action, trip }); setReviewText(''); }
    function submitReview(event) {
        event.preventDefault();
        if (review.action === 'approve') {
            try { tripPayment(review.trip.miles, rate); } catch (error) { toast.error(error.message); return; }
        }
        mutation.mutate({ action: review.action, trip_id: review.trip.id, rate_per_mile: rate, review_note: reviewText, payment_reference: reviewText });
    }
    return <div className="space-y-4 text-white">
        <div className={`${panel} flex flex-col md:flex-row gap-4 md:items-center md:justify-between`}>
            <div><h2 className="flex items-center gap-2 text-lg font-bold"><Car className="h-5 w-5 text-yellow-500" />Driving accounting</h2><p className="mt-1 max-w-2xl text-xs leading-relaxed text-gray-400">Log completed business trips using the vehicle’s start and end odometer in miles. Mileage is rep-reported and reviewed by the manager. Planned route distances are estimates and are excluded.</p></div>
            <Button onClick={openForm} disabled={teamLoading || eligiblePeople.length === 0} className="bg-yellow-500 text-black hover:bg-yellow-400 shrink-0"><Plus className="h-4 w-4 mr-2" />Log business trip</Button>
        </div>
        <div className={`${panel} grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end`}>
            <FormField label="From date"><Input aria-label="From date" type="date" value={start} onChange={e => setStart(e.target.value)} className={field} /></FormField>
            <FormField label="Through date"><Input aria-label="Through date" type="date" value={end} onChange={e => setEnd(e.target.value)} className={field} /></FormField>
            <FormField label={canManage ? 'Rep breakdown' : 'Your trips'}><select aria-label="Rep breakdown" className={`${field} h-10 rounded-md border px-3 text-sm`} value={selected} onChange={e => setSelected(e.target.value)}><option value="all">{canManage ? 'All team members' : 'All my trips'}</option>{people.map(m => <option key={m.drivingId} value={m.drivingId}>{m.name}{m.status === 'inactive' ? ' (inactive / former)' : ''}</option>)}</select></FormField>
            <Button variant="outline" className="border-gray-700" disabled={!ready || !displayedTrips.length} onClick={() => downloadDrivingCsv(displayedTrips, start, end, chosenPerson?.name || (canManage ? 'team' : 'my_trips'))}><Download className="h-4 w-4 mr-2" />Download {selected === 'all' && canManage ? 'team' : 'rep'} CSV</Button>
        </div>
        {!validRange ? <p role="alert" className="text-red-400 text-sm">Choose a valid date range with the start before the end.</p>
            : query.isError ? <div role="alert" className={panel}><p className="text-red-400 text-sm">{query.error?.response?.data?.error || query.error?.message || 'Unable to load driving records.'}</p><Button onClick={() => query.refetch()} variant="outline" className="mt-3">Retry</Button></div>
                : query.isLoading || teamLoading ? <p className="text-gray-400 text-sm">Loading driving records…</p> : <>
                    <Totals trips={displayedTrips} />
                    {canManage && selected === 'all' && <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{people.map(person => {
                        const repTrips = trips.filter(t => matchesMember(t, person));
                        const totals = drivingTotals(repTrips);
                        return <div key={person.drivingId} className={panel}><div className="flex items-start justify-between gap-2"><button className="text-left font-bold hover:text-yellow-400" onClick={() => setSelected(person.drivingId)}>{person.name}<span className="block mt-1 text-xs font-normal text-gray-500">{person.status === 'inactive' ? 'Inactive / former member' : 'View trip breakdown'}</span></button><Button size="icon" variant="ghost" aria-label={`Download ${person.name} mileage CSV`} disabled={!ready || !repTrips.length} onClick={() => downloadDrivingCsv(repTrips, start, end, person.name)}><Download className="h-4 w-4" /></Button></div><div className="mt-4 flex justify-between text-sm"><span>{totals.miles.toFixed(1)} mi · {totals.trips} trips</span><span className="text-yellow-400">{money(totals.due_cents)} due</span></div><p className="mt-1 text-xs text-gray-500">{totals.submitted_miles.toFixed(1)} mi pending · {money(totals.paid_cents)} paid</p></div>;
                    })}</div>}
                    <div className={`${panel} !p-0 overflow-hidden`}>
                        <div className="p-4 flex items-center justify-between"><div><h3 className="font-bold">{chosenPerson?.name || (canManage ? 'Team' : 'Your')} trip breakdown</h3><p className="mt-1 text-xs text-gray-500">{start} through {end} · USD · odometer miles</p></div><Button size="icon" variant="ghost" aria-label="Refresh driving records" disabled={query.isFetching} onClick={() => query.refetch()}><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></Button></div>
                        {!displayedTrips.length ? <div className="p-6 text-sm text-gray-400">No driving logs in this range. Log a completed trip to start the mileage record. Earlier mileage requires actual odometer records.</div>
                            : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-black/50 text-gray-500"><tr>{['Rep / date', 'Trip / purpose', 'Odometer (mi)', 'Miles', 'Reimbursement', 'Status / actions'].map(h => <th key={h} className="px-4 py-3 whitespace-nowrap">{h}</th>)}</tr></thead><tbody>{displayedTrips.map(t => <tr key={t.id} className="border-t border-gray-800 align-top"><td className="px-4 py-3 min-w-32"><p className="font-semibold">{t.rep_name}</p><p className="mt-1 text-gray-500">{t.trip_date}</p></td><td className="px-4 py-3 min-w-52 max-w-xs"><p className="break-words">{t.origin} → {t.destination}</p><p className="mt-1 text-gray-400 break-words">{t.purpose}</p><p className="mt-1 text-gray-500 break-words">{t.vehicle}{t.notes ? ` · ${t.notes}` : ''}</p>{t.review_note && <p className="mt-1 text-gray-400 break-words">Reason: {t.review_note}</p>}</td><td className="px-4 py-3 whitespace-nowrap">{Number(t.odometer_start).toFixed(1)} → {Number(t.odometer_end).toFixed(1)}</td><td className="px-4 py-3 font-bold whitespace-nowrap">{Number(t.miles).toFixed(1)} mi</td><td className="px-4 py-3 whitespace-nowrap">{t.reimbursement_cents == null ? <span className="text-gray-500">Awaiting approval</span> : <><p>{money(t.reimbursement_cents)}</p><p className="mt-1 text-gray-500">${t.rate_per_mile}/mi</p>{t.paid_at && <p className="mt-1 text-gray-500">Paid {localDrivingDate(new Date(t.paid_at))}</p>}{t.payment_reference && <p className="mt-1 text-gray-500 whitespace-normal break-words">Ref: {t.payment_reference}</p>}</>}</td><td className="px-4 py-3 min-w-44"><span className={`capitalize font-semibold ${statusColors[t.status]}`}>{t.status}</span><div className="flex flex-wrap gap-1 mt-2">{canManage && t.status === 'submitted' && <><Button size="sm" variant="outline" className="h-7 text-xs border-gray-700" disabled={mutation.isPending || !ready} onClick={() => openReview('approve', t)}>Approve</Button><Button size="sm" variant="ghost" className="h-7 text-xs text-red-400" disabled={mutation.isPending || !ready} onClick={() => openReview('reject', t)}>Reject</Button></>}{canManage && t.status === 'approved' && <Button size="sm" variant="outline" className="h-7 text-xs border-gray-700" disabled={mutation.isPending || !ready} onClick={() => openReview('pay', t)}>Mark paid</Button>}{!canManage && t.status === 'submitted' && <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={mutation.isPending || !ready} onClick={() => openReview('cancel', t)}>Cancel / correct</Button>}</div></td></tr>)}</tbody></table></div>}
                    </div>
                    <p className="text-xs text-gray-500">Downloads include trip details, review status, the approved rate, and payment references. Rejected and cancelled trips remain in the record and are excluded from totals. Mark paid records a reimbursement you made; it does not send money.</p>
                </>}

        <Dialog open={!!form} onOpenChange={open => { if (!open && !mutation.isPending) setForm(null); }}><DialogContent className="bg-[#111] border-gray-800 text-white max-w-xl max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Log business trip</DialogTitle><DialogDescription>Enter actual odometer readings in miles for a completed business trip. Record each trip separately and exclude personal driving.</DialogDescription></DialogHeader>{form && <form className="space-y-3" onSubmit={event => { event.preventDefault(); try { tripMiles(form.odometer_start, form.odometer_end); } catch (error) { toast.error(error.message); return; } mutation.mutate({ ...form, action: 'submit' }); }}>
            {canManage && <FormField label="Team member"><select required value={form.member_id} onChange={e => updateForm('member_id', e.target.value)} className={`${field} h-10 rounded-md border px-3`}>{eligiblePeople.map(m => <option key={m.drivingId} value={m.drivingId}>{m.name}</option>)}</select></FormField>}
            <div className="grid grid-cols-2 gap-3"><FormField label="Trip date"><Input required type="date" max={localDrivingDate()} className={field} value={form.trip_date} onChange={e => updateForm('trip_date', e.target.value)} /></FormField><FormField label="Vehicle / identifier"><Input required maxLength={100} placeholder="e.g. White Corolla" className={field} value={form.vehicle} onChange={e => updateForm('vehicle', e.target.value)} /></FormField></div>
            <div className="grid grid-cols-2 gap-3">{[['origin', 'Starting location'], ['destination', 'Destination']].map(([key, label]) => <FormField key={key} label={label}><Input required maxLength={300} className={field} value={form[key]} onChange={e => updateForm(key, e.target.value)} /></FormField>)}</div>
            <FormField label="Business purpose"><Input required maxLength={500} placeholder="e.g. Customer visits in assigned territory" className={field} value={form.purpose} onChange={e => updateForm('purpose', e.target.value)} /></FormField>
            <div className="grid grid-cols-2 gap-3">{[['odometer_start', 'Starting odometer (mi)'], ['odometer_end', 'Ending odometer (mi)']].map(([key, label]) => <FormField key={key} label={label}><Input required type="number" min="0" max="1000000" step="0.1" className={field} value={form[key]} onChange={e => updateForm(key, e.target.value)} /></FormField>)}</div>
            <p className="text-sm text-yellow-400" aria-live="polite">{preview || 'Mileage = ending odometer − starting odometer'}</p>
            <FormField label="Notes (optional)"><Input maxLength={1000} className={field} value={form.notes} onChange={e => updateForm('notes', e.target.value)} /></FormField>
            <p className="text-xs text-gray-500">For a correction, cancel or ask your manager to reject the submitted trip, then log the corrected readings. Approved and paid records are preserved.</p>
            <Button type="submit" disabled={mutation.isPending} className="w-full bg-yellow-500 text-black hover:bg-yellow-400">{mutation.isPending ? 'Submitting…' : 'Submit trip'}</Button>
        </form>}</DialogContent></Dialog>

        <Dialog open={!!review} onOpenChange={open => { if (!open && !mutation.isPending) setReview(null); }}><DialogContent className="bg-[#111] border-gray-800 text-white"><DialogHeader><DialogTitle>{review?.action === 'approve' ? 'Approve reimbursement' : review?.action === 'pay' ? 'Record payment' : review?.action === 'cancel' ? 'Cancel trip for correction' : 'Reject trip'}</DialogTitle><DialogDescription>{review?.trip.rep_name} · {review?.trip.trip_date} · {review?.trip.miles.toFixed(1)} miles</DialogDescription></DialogHeader>{review && <form className="space-y-4" onSubmit={submitReview}>
            {review.action === 'approve' ? <><FormField label="Reimbursement rate (USD per mile)"><Input required type="number" min="0" max="10" step="0.0001" placeholder="Enter your company rate" value={rate} onChange={e => setRate(e.target.value)} className={field} /></FormField><p className="text-sm text-gray-400">{approvalPreview ? `Approve ${approvalPreview} for this trip.` : 'Enter a rate to calculate reimbursement.'} The approved rate is saved with this trip.</p></> : <FormField label={review.action === 'pay' ? 'Payment reference (e.g. payroll run or transfer ID)' : 'Reason'}><Input required maxLength={review.action === 'pay' ? 200 : 500} className={field} value={reviewText} onChange={e => setReviewText(e.target.value)} /></FormField>}
            {review.action === 'pay' && <p className="text-sm text-gray-400">Record {money(review.trip.reimbursement_cents)} as paid after sending the reimbursement.</p>}
            <Button disabled={mutation.isPending} type="submit" className="w-full bg-yellow-500 text-black hover:bg-yellow-400">{mutation.isPending ? 'Saving…' : review.action === 'approve' ? 'Approve trip' : review.action === 'pay' ? 'Mark paid' : review.action === 'cancel' ? 'Cancel trip' : 'Reject trip'}</Button>
        </form>}</DialogContent></Dialog>
    </div>;
}
