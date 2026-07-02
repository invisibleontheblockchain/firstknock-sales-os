import React, { useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, Radio } from 'lucide-react';

const formatMoney = (value) => {
    const amount = Number(value) || 0;
    return amount.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
};

const formatSaleTime = (dateValue) => {
    if (!dateValue) return 'Time unknown';
    return new Date(dateValue).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
};

export default function SalesEditor({ logs = [], members = [] }) {
    const queryClient = useQueryClient();

    useEffect(() => {
        const unsubscribe = base44.entities.InteractionLog.subscribe(() => {
            queryClient.invalidateQueries({ queryKey: ['teamLogs'] });
        });
        return unsubscribe;
    }, [queryClient]);

    const repMap = useMemo(() => {
        const namesByEmail = {};
        members.forEach(member => {
            const email = member.email?.trim().toLowerCase();
            if (email && member.name) namesByEmail[email] = member.name;
        });
        return namesByEmail;
    }, [members]);

    const sales = useMemo(() => {
        return logs
            .filter(log => log.parsed_status === 'SOLD')
            .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
            .slice(0, 50);
    }, [logs]);

    return (
        <Card className="bg-[#111] border-gray-800">
            <CardHeader className="px-3 md:px-6 py-3 md:py-4 border-b border-gray-800">
                <CardTitle className="text-sm md:text-base font-bold text-white flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-green-500" />
                        Live Sales Feed
                    </span>
                    <span className="flex items-center gap-1.5 text-[10px] font-bold text-green-400 uppercase tracking-wide">
                        <Radio className="w-3 h-3" /> Live
                    </span>
                </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
                <div className="divide-y divide-gray-800/50 max-h-[400px] md:max-h-[500px] overflow-y-auto">
                    {sales.length === 0 ? (
                        <div className="text-center py-8 text-gray-500 text-xs">No sales logged yet.</div>
                    ) : sales.map(log => {
                        const repEmail = (log.created_by || '').trim().toLowerCase();
                        const repName = repMap[repEmail] || 'Unknown rep';
                        return (
                            <div key={log.id} className="flex items-center justify-between gap-3 px-3 md:px-5 py-3 hover:bg-white/5 transition-colors">
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-white truncate">{repName}</p>
                                    <p className="text-[10px] text-gray-500 mt-0.5">{formatSaleTime(log.created_date)}</p>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="text-base md:text-lg font-black text-green-400">{formatMoney(log.sale_amount)}</p>
                                    <p className="text-[9px] text-gray-600 uppercase tracking-wide">Sale value</p>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}