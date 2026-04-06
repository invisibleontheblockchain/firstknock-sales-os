import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DollarSign, Pencil, Check, X, Search, Plus } from 'lucide-react';
import { toast } from 'sonner';

const STATUS_OPTIONS = ['SOLD', 'QUALIFIED', 'HARD_NO', 'CALLBACK', 'NO_ANSWER', 'ELIGIBLE'];
const STATUS_COLORS = {
    SOLD: 'bg-green-500/20 text-green-400 border-green-500/30',
    QUALIFIED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    HARD_NO: 'bg-red-500/20 text-red-400 border-red-500/30',
    CALLBACK: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    NO_ANSWER: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    ELIGIBLE: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

function EditRow({ log, onSave, onCancel }) {
    const [status, setStatus] = useState(log.parsed_status);
    const [amount, setAmount] = useState(log.sale_amount || '');

    const handleSave = async () => {
        const updates = { parsed_status: status };
        const numAmount = parseFloat(amount);
        if (!isNaN(numAmount) && numAmount >= 0) {
            updates.sale_amount = numAmount;
        } else if (amount === '' || amount === '0') {
            updates.sale_amount = 0;
        }
        await base44.entities.InteractionLog.update(log.id, updates);
        onSave();
    };

    return (
        <div className="flex items-center gap-2 p-2 bg-yellow-500/5 rounded-lg border border-yellow-500/20">
            <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white truncate">{log.raw_input_text || 'No notes'}</p>
                <p className="text-[9px] text-gray-500">{new Date(log.created_date).toLocaleDateString()}</p>
            </div>
            <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[110px] h-7 text-[10px] bg-black border-gray-700">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#111] border-gray-800 text-white">
                    {STATUS_OPTIONS.map(s => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <div className="relative w-[90px]">
                <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500" />
                <Input
                    type="number"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0"
                    className="h-7 text-[10px] bg-black border-gray-700 pl-6 w-full"
                />
            </div>
            <Button size="icon" onClick={handleSave} className="h-7 w-7 bg-green-600 hover:bg-green-500 shrink-0">
                <Check className="w-3 h-3" />
            </Button>
            <Button size="icon" variant="ghost" onClick={onCancel} className="h-7 w-7 text-gray-400 shrink-0">
                <X className="w-3 h-3" />
            </Button>
        </div>
    );
}

export default function SalesEditor({ logs = [], members = [] }) {
    const queryClient = useQueryClient();
    const [editingId, setEditingId] = useState(null);
    const [search, setSearch] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [addOpen, setAddOpen] = useState(false);
    const [newEntry, setNewEntry] = useState({ address_hash: '', raw_input_text: '', parsed_status: 'SOLD', sale_amount: '' });

    // Only show logs with meaningful interactions — most recent first, limited
    const filteredLogs = useMemo(() => {
        let result = [...logs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
        if (filterStatus !== 'all') {
            result = result.filter(l => l.parsed_status === filterStatus);
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            result = result.filter(l =>
                (l.raw_input_text || '').toLowerCase().includes(q) ||
                (l.address_hash || '').toLowerCase().includes(q) ||
                (l.created_by || '').toLowerCase().includes(q)
            );
        }
        return result.slice(0, 100);
    }, [logs, filterStatus, search]);

    const handleSave = () => {
        setEditingId(null);
        queryClient.invalidateQueries({ queryKey: ['teamLogs'] });
        toast.success('Updated successfully');
    };

    const handleAddEntry = async () => {
        if (!newEntry.raw_input_text.trim()) {
            toast.error('Please add a note/description');
            return;
        }
        await base44.entities.InteractionLog.create({
            address_hash: newEntry.address_hash || `manual_${Date.now()}`,
            raw_input_text: newEntry.raw_input_text,
            parsed_status: newEntry.parsed_status,
            sale_amount: parseFloat(newEntry.sale_amount) || 0,
        });
        queryClient.invalidateQueries({ queryKey: ['teamLogs'] });
        setAddOpen(false);
        setNewEntry({ address_hash: '', raw_input_text: '', parsed_status: 'SOLD', sale_amount: '' });
        toast.success('Entry added');
    };

    const repMap = useMemo(() => {
        const m = {};
        members.forEach(mem => { m[mem.email] = mem.name; });
        return m;
    }, [members]);

    return (
        <Card className="bg-[#111] border-gray-800">
            <CardHeader className="px-3 md:px-6 py-3 md:py-4 border-b border-gray-800">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-2">
                    <CardTitle className="text-sm md:text-base font-bold text-white flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-green-500" />
                        Sales & Revenue Editor
                    </CardTitle>
                    <div className="flex items-center gap-2 w-full md:w-auto">
                        <div className="relative flex-1 md:flex-none">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500" />
                            <Input
                                placeholder="Search..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="h-7 text-xs bg-black border-gray-700 pl-7 w-full md:w-48"
                            />
                        </div>
                        <Select value={filterStatus} onValueChange={setFilterStatus}>
                            <SelectTrigger className="h-7 text-[10px] bg-black border-gray-700 w-[100px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-[#111] border-gray-800 text-white">
                                <SelectItem value="all">All</SelectItem>
                                {STATUS_OPTIONS.map(s => (
                                    <SelectItem key={s} value={s}>{s}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-[10px] bg-green-600 hover:bg-green-500 text-white font-bold px-3 shrink-0">
                            <Plus className="w-3 h-3 mr-1" /> Add Sale
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="p-0">
                <div className="divide-y divide-gray-800/50 max-h-[400px] md:max-h-[500px] overflow-y-auto">
                    {filteredLogs.length === 0 && (
                        <div className="text-center py-8 text-gray-500 text-xs">No interaction logs found.</div>
                    )}
                    {filteredLogs.map(log => (
                        <div key={log.id}>
                            {editingId === log.id ? (
                                <div className="p-2">
                                    <EditRow log={log} onSave={handleSave} onCancel={() => setEditingId(null)} />
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 md:gap-3 px-3 py-2 hover:bg-white/5 transition-colors group">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="text-xs font-bold text-white truncate max-w-[200px]">
                                                {log.raw_input_text || 'No notes'}
                                            </p>
                                            <Badge className={`text-[8px] border ${STATUS_COLORS[log.parsed_status] || STATUS_COLORS.ELIGIBLE}`}>
                                                {log.parsed_status}
                                            </Badge>
                                        </div>
                                        <div className="flex items-center gap-2 text-[9px] text-gray-500 mt-0.5">
                                            <span>{new Date(log.created_date).toLocaleDateString()}</span>
                                            <span>•</span>
                                            <span>{repMap[log.created_by] || log.created_by || 'Unknown'}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {log.sale_amount > 0 && (
                                            <span className="text-xs font-bold text-green-400">${log.sale_amount.toLocaleString()}</span>
                                        )}
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => setEditingId(log.id)}
                                            className="h-6 w-6 text-gray-600 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <Pencil className="w-3 h-3" />
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </CardContent>

            {/* Add Manual Sale Dialog */}
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent className="bg-[#111] border-gray-800 text-white sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-white flex items-center gap-2">
                            <DollarSign className="w-5 h-5 text-green-500" />
                            Add Sale / Revenue Entry
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Notes / Description</label>
                            <Input
                                value={newEntry.raw_input_text}
                                onChange={e => setNewEntry({ ...newEntry, raw_input_text: e.target.value })}
                                placeholder="e.g. Sold solar panel install to John Smith"
                                className="bg-black border-gray-700"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-bold text-gray-500 uppercase">Status</label>
                                <Select value={newEntry.parsed_status} onValueChange={v => setNewEntry({ ...newEntry, parsed_status: v })}>
                                    <SelectTrigger className="bg-black border-gray-700">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="bg-[#111] border-gray-800 text-white">
                                        {STATUS_OPTIONS.map(s => (
                                            <SelectItem key={s} value={s}>{s}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-bold text-gray-500 uppercase">Sale Amount ($)</label>
                                <Input
                                    type="number"
                                    value={newEntry.sale_amount}
                                    onChange={e => setNewEntry({ ...newEntry, sale_amount: e.target.value })}
                                    placeholder="0"
                                    className="bg-black border-gray-700"
                                />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Address / Property ID (optional)</label>
                            <Input
                                value={newEntry.address_hash}
                                onChange={e => setNewEntry({ ...newEntry, address_hash: e.target.value })}
                                placeholder="Leave blank for manual entry"
                                className="bg-black border-gray-700"
                            />
                        </div>
                        <Button onClick={handleAddEntry} className="w-full bg-green-600 hover:bg-green-500 text-white font-bold">
                            Save Entry
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </Card>
    );
}