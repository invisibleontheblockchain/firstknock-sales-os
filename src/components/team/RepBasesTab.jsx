import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { geocodeAddress } from '@/lib/geocoding';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

function BaseCard({ member, base, onSave }) {
    const [address, setAddress] = useState('');
    const [resolved, setResolved] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function run(task) {
        setBusy(true); setError('');
        try { await task(); }
        catch (err) { setError(err.response?.data?.error || err.message || 'Could not save this base.'); }
        finally { setBusy(false); }
    }
    return <section className="rounded-xl border border-white/10 bg-[#111] p-4 space-y-3">
        <div>
            <h3 className="font-bold text-white">{member.name}</h3>
            <p className="mt-1 text-sm text-gray-400 break-words">{base?.home_base?.address || 'No base configured'}</p>
        </div>
        {!base?.configurable ? <p className="text-xs text-amber-300">This rep must join the team before their base can be configured.</p> : <>
            <label className="flex items-start gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={base.auto_assign} disabled={busy} className="mt-1 accent-yellow-500"
                    onChange={event => { const auto_assign = event.target.checked; run(() => onSave(member.id, { auto_assign })); }} />
                Use this base automatically when assigning a route
            </label>
            <Input aria-label={`Base address for ${member.name}`} value={address} disabled={busy}
                onChange={event => { setAddress(event.target.value); setResolved(null); setError(''); }}
                placeholder="Street address, city, state, ZIP" className="bg-black border-gray-700 text-white" />
            {resolved && <p className="text-sm text-yellow-300">Confirm this address: {resolved.address}</p>}
            <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !address.trim()} className="bg-yellow-500 text-black hover:bg-yellow-400"
                    onClick={() => run(async () => {
                        if (!resolved) { setResolved(await geocodeAddress(address)); return; }
                        await onSave(member.id, { home_base: resolved }); setAddress(''); setResolved(null);
                    })}>{busy ? 'Working…' : resolved ? 'Save base' : 'Find address'}</Button>
                {base.home_base && <Button variant="outline" disabled={busy} className="border-gray-700 bg-black"
                    onClick={() => run(() => onSave(member.id, { home_base: null }))}>Clear base</Button>}
            </div>
        </>}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </section>;
}

export default function RepBasesTab({ members, managerId }) {
    const queryClient = useQueryClient();
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['repBases', managerId],
        queryFn: async () => (await base44.functions.invoke('manageRepAnchors', { action: 'list' })).data.bases,
    });
    async function onSave(memberId, update) {
        await base44.functions.invoke('manageRepAnchors', { action: 'save_base', member_id: memberId, ...update });
        await queryClient.invalidateQueries({ queryKey: ['repBases'] });
        queryClient.invalidateQueries({ queryKey: ['routeAnchor'] });
        queryClient.invalidateQueries({ queryKey: ['user'] });
        toast.success('Rep base updated');
    }
    return <div className="space-y-4">
        <p className="text-sm text-gray-400">Manage your team’s base addresses here. Bases are visible to managers and the rep they belong to. Routes start and finish at their selected anchor.</p>
        {isLoading ? <p className="text-gray-400">Loading bases…</p> : error ? <div role="alert" className="text-red-400">Could not load bases. <Button variant="outline" onClick={() => refetch()}>Retry</Button></div> :
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {members.map(member => <BaseCard key={member.id} member={member} base={data?.find(base => base.member_id === (member.isManagerSelf ? managerId : member.id))}
                    onSave={(id, update) => onSave(member.isManagerSelf ? managerId : id, update)} />)}
            </div>}
    </div>;
}
