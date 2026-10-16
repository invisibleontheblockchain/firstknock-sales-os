import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';

const panel = 'rounded-xl border border-gray-800 bg-[#111] p-4 md:p-5';
const label = status => status === 'recorded' ? 'Recorded coverage' : status === 'partial' ? 'Partial coverage' : 'Not recorded';
const miles = value => value == null ? 'Not recorded' : `${Number(value).toFixed(1)} mi`;
const match = (row, person) => row.rep_user_id === person?.user_id || row.member_id === person?.id;
const csvCell = value => `"${String(value ?? '').replace(/^[=+@-]/, value => `'${value}`).replaceAll('"', '""')}"`;
export function autoDrivingCsv(rows, timezone) {
    return [['Rep', 'Measured GPS driving miles', 'Coverage status', 'GPS observed seconds', 'Clocked-in seconds', 'Coverage percent', 'Last GPS sample', 'Reporting timezone'],
        ...rows.map(row => [row.rep_name, row.miles ?? '', label(row.status), row.observed_seconds, row.working_seconds,
            Math.round(row.coverage * 100), row.last_observed_at || '', timezone])].map(row => row.map(csvCell).join(',')).join('\r\n');
}
export default function AutoDrivingReport({ managerId, currentUser, members, canManage, allTeams, chosenPerson, start, end, validRange }) {
    const query = useQuery({ queryKey: ['autoDriving', managerId, currentUser?.id, start, end],
        enabled: !!managerId && !!currentUser?.id && validRange,
        refetchInterval: 30000, refetchIntervalInBackground: false,
        queryFn: async () => {
            const response = await base44.functions.invoke('autoDriving', { action: 'report', start_date: start, end_date: end });
            if (!response.data?.success || response.data.manager_id !== managerId || !Array.isArray(response.data.reps)) throw new Error('GPS mileage could not be verified.');
            return response.data;
        } });
    const rows = useMemo(() => (query.data?.reps || []).filter(row => (!canManage || allTeams || members.some(member => match(row, member)))
        && (!chosenPerson || match(row, chosenPerson))), [query.data, canManage, allTeams, members, chosenPerson]);
    const measured = rows.filter(row => row.miles != null);
    const total = measured.length ? measured.reduce((sum, row) => sum + row.miles, 0) : null;
    function download() {
        const url = URL.createObjectURL(new Blob(['\uFEFF', autoDrivingCsv(rows, query.data.timezone)], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `gps_driving_${start}_${end}.csv`; anchor.click(); URL.revokeObjectURL(url);
    }
    return <section className={`${panel} space-y-4`} aria-label="Automatic GPS driving mileage">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold">Automatic GPS driving miles</h3>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-gray-400">Measured from consecutive precise GPS samples during clocked-in shifts after the rep enables mileage on their device. GPS syncs up to every five minutes. Walking and planned route estimates are excluded. Hidden or locked screens, GPS gaps, and slow traffic can leave partial mileage.</p></div>
            <div className="flex gap-2"><Button size="sm" variant="outline" className="border-gray-700" disabled={!rows.length || query.isFetching || query.isError} onClick={download}><Download className="mr-2 h-4 w-4" />GPS CSV</Button>
                <Button size="icon" variant="ghost" aria-label="Refresh GPS driving mileage" disabled={query.isFetching || !validRange} onClick={() => query.refetch()}><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></Button></div></div>
        {query.isError ? <p role="alert" className="text-sm text-red-400">{query.error?.response?.data?.error || query.error.message}</p>
            : query.isLoading ? <p className="text-sm text-gray-400">Loading GPS mileage…</p> : <>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><p className="text-2xl font-bold">{miles(total)}</p><p className="text-xs text-gray-400">{measured.length} of {rows.length} people with GPS coverage · {rows.filter(row => row.status === 'partial').length} partial</p></div>
                <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-gray-500"><tr>{['Rep', 'GPS driving miles', 'Coverage', 'GPS observed / clocked in'].map(heading => <th key={heading} className="py-2 pr-4 whitespace-nowrap">{heading}</th>)}</tr></thead>
                    <tbody>{rows.map(row => <tr key={row.rep_user_id} className="border-t border-gray-800"><td className="py-3 pr-4 font-semibold">{row.rep_name}</td><td className="py-3 pr-4 whitespace-nowrap">{miles(row.miles)}</td><td className={`py-3 pr-4 whitespace-nowrap ${row.status === 'partial' ? 'text-amber-300' : 'text-gray-400'}`}>{label(row.status)}{row.working_seconds > 0 && ` · ${Math.round(row.coverage * 100)}%`}</td><td className="py-3 pr-4 whitespace-nowrap text-gray-400">{Math.floor(row.observed_seconds / 60)}m / {(row.working_seconds / 3600).toFixed(1)}h</td></tr>)}</tbody></table></div>
                {!rows.length && <p className="text-sm text-gray-400">No team members in this view.</p>}
            </>}
        <p className="text-[11px] leading-relaxed text-gray-500">Earlier shifts without recorded GPS have unknown driving mileage. Zero is shown only when GPS coverage exists and no qualifying driving movement was measured. GPS miles do not create reimbursement claims or payments; odometer claims below are reviewed separately.</p>
    </section>;
}
