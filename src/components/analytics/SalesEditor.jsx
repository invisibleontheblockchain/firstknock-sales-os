import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CalendarDays, DollarSign, Edit3, MapPin, Route, Trash2, User } from 'lucide-react';
import {
  buildSalesRows,
  buildSaleUpdatePayload,
  SALE_OUTCOME,
  SALE_OUTCOME_OPTIONS,
} from './salesManagement';

const SALES_QUERY_PREFIXES = [
  ['salesManagerLogs'],
  ['interactionLogs'],
  ['teamLogs'],
  ['routeLogs'],
  ['allMyLogs'],
  ['myLogs'],
  ['propertyHistory'],
  ['selectedPropertyHistory'],
];

function formatMoney(value) {
  return Number(value).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatSaleDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function SalesEditor({
  logs = [],
  members = [],
  routes = [],
  properties = [],
  currentUser = null,
}) {
  const queryClient = useQueryClient();
  const [selectedSaleId, setSelectedSaleId] = useState(null);
  const [draft, setDraft] = useState({ amount: '', outcome: SALE_OUTCOME, notes: '' });
  const [formError, setFormError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const sales = useMemo(() => buildSalesRows({
    logs,
    members,
    routes,
    properties,
    currentUser,
  }), [currentUser, logs, members, properties, routes]);
  const selectedSale = sales.find((sale) => sale.id === selectedSaleId) || null;
  const totalRevenue = sales.reduce((sum, sale) => sum + (sale.amountRecorded ? sale.amount : 0), 0);
  const valuedSales = sales.filter((sale) => sale.amountRecorded).length;

  const invalidateSalesData = () => Promise.all(
    SALES_QUERY_PREFIXES.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );

  useEffect(() => {
    const unsubscribe = base44.entities.InteractionLog.subscribe(() => {
      SALES_QUERY_PREFIXES.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
    });
    return unsubscribe;
  }, [queryClient]);

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => base44.entities.InteractionLog.update(id, payload),
    onSuccess: async () => {
      await invalidateSalesData();
      setSelectedSaleId(null);
      setConfirmingDelete(false);
      toast.success('Sale updated');
    },
    onError: (error) => setFormError(error?.message || 'The sale could not be updated.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.InteractionLog.delete(id),
    onSuccess: async () => {
      await invalidateSalesData();
      setSelectedSaleId(null);
      setConfirmingDelete(false);
      toast.success('Accidental sale deleted');
    },
    onError: (error) => setFormError(error?.message || 'The sale could not be deleted.'),
  });

  const openEditor = (sale) => {
    setSelectedSaleId(sale.id);
    setDraft({
      amount: sale.amountRecorded ? String(sale.amount) : '',
      outcome: sale.outcome,
      notes: sale.notes,
    });
    setFormError('');
    setConfirmingDelete(false);
  };

  const closeEditor = () => {
    if (updateMutation.isPending || deleteMutation.isPending) return;
    setSelectedSaleId(null);
    setFormError('');
    setConfirmingDelete(false);
  };

  const saveChanges = () => {
    if (!selectedSale?.log?.id) return setFormError('This sale is missing its record ID and cannot be edited.');
    const { payload, error } = buildSaleUpdatePayload({
      amountInput: draft.amount,
      outcome: draft.outcome,
      notes: draft.notes,
    });
    if (error) return setFormError(error);
    setFormError('');
    updateMutation.mutate({ id: selectedSale.log.id, payload });
  };

  const deleteSale = () => {
    if (!selectedSale?.log?.id) return setFormError('This sale is missing its record ID and cannot be deleted.');
    setFormError('');
    deleteMutation.mutate(selectedSale.log.id);
  };

  return (
    <>
      <Card className="overflow-hidden border-white/[0.08] bg-gradient-to-br from-[#121216] via-[#0d0d11] to-[#070708] text-white shadow-2xl shadow-black/30">
        <CardHeader className="border-b border-white/[0.07] px-4 py-4 md:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base font-black md:text-lg">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-green-400/20 bg-green-500/10">
                  <DollarSign className="h-4 w-4 text-green-400" />
                </span>
                Sales Manager
              </CardTitle>
              <p className="mt-1 text-[11px] text-gray-400">Review, correct, and manage every recorded sale.</p>
            </div>
            <div className="flex gap-2 text-right">
              <div className="rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Sales</p>
                <p className="text-sm font-black text-white">{sales.length.toLocaleString()}</p>
              </div>
              <div className="rounded-xl border border-green-400/15 bg-green-500/[0.07] px-3 py-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-green-300/60">Recorded revenue</p>
                <p className="text-sm font-black text-green-400">{formatMoney(totalRevenue)}</p>
              </div>
            </div>
          </div>
          {sales.length > 0 && valuedSales < sales.length && (
            <p className="mt-2 text-[10px] text-gray-500">
              {sales.length - valuedSales} {sales.length - valuedSales === 1 ? 'sale has' : 'sales have'} no amount entered and {sales.length - valuedSales === 1 ? 'is' : 'are'} excluded from revenue.
            </p>
          )}
        </CardHeader>

        <CardContent className="p-0">
          {sales.length === 0 ? (
            <div className="px-5 py-14 text-center">
              <DollarSign className="mx-auto h-8 w-8 text-gray-700" />
              <p className="mt-3 text-sm font-bold text-gray-300">No sales recorded yet</p>
              <p className="mt-1 text-xs text-gray-500">Sales logged from a route will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {sales.map((sale) => (
                <button
                  type="button"
                  key={sale.id}
                  onClick={() => openEditor(sale)}
                  aria-label={`Edit sale at ${sale.address}`}
                  className="group grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-4 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-400 md:grid-cols-[minmax(220px,1.45fr)_minmax(130px,0.75fr)_minmax(120px,0.7fr)_minmax(120px,0.7fr)_auto] md:items-center md:px-6"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-white">{sale.address}</p>
                    <p className="mt-1 flex items-center gap-1 truncate text-[10px] text-gray-500">
                      <User className="h-3 w-3 shrink-0" /> {sale.homeowner}
                    </p>
                    {sale.notes && <p className="mt-1 line-clamp-1 text-[10px] text-gray-400">{sale.notes}</p>}
                  </div>

                  <div className="row-span-2 text-right md:row-span-1 md:text-left">
                    <p className={`text-base font-black ${sale.amountRecorded ? 'text-green-400' : 'text-gray-500'}`}>
                      {sale.amountRecorded ? formatMoney(sale.amount) : 'Not entered'}
                    </p>
                    <p className="mt-0.5 text-[9px] font-bold uppercase tracking-wider text-gray-600">Sale amount</p>
                  </div>

                  <div className="min-w-0">
                    <p className="flex items-center gap-1 text-[10px] font-bold text-gray-300"><CalendarDays className="h-3 w-3 text-gray-500" /> {formatSaleDate(sale.createdAt)}</p>
                    <p className="mt-1 flex items-center gap-1 truncate text-[10px] text-gray-500"><User className="h-3 w-3 shrink-0" /> {sale.repName}</p>
                  </div>

                  <div className="min-w-0">
                    <p className="flex items-center gap-1 truncate text-[10px] text-gray-400"><Route className="h-3 w-3 shrink-0" /> {sale.routeName}</p>
                    <p className="mt-1 inline-flex rounded-full border border-green-400/15 bg-green-500/10 px-2 py-0.5 text-[9px] font-black text-green-400">{sale.outcome}</p>
                  </div>

                  <span className="hidden h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-gray-500 transition-colors group-hover:text-white md:flex">
                    <Edit3 className="h-3.5 w-3.5" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedSale} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%_-_1.5rem)] max-w-lg overflow-y-auto border-white/10 bg-[#0b0b0e] p-5 text-white sm:p-6">
          <DialogHeader>
            <DialogTitle className="pr-8 text-left text-lg font-black">Edit sale</DialogTitle>
            <DialogDescription className="text-left text-xs text-gray-400">
              Correct the revenue, outcome, or notes for {selectedSale?.address || 'this property'}.
            </DialogDescription>
          </DialogHeader>

          {selectedSale && (
            <div className="space-y-4">
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
                <p className="flex items-start gap-2 text-sm font-bold text-white"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-green-400" /> {selectedSale.address}</p>
                <p className="mt-1 pl-6 text-[10px] text-gray-500">{selectedSale.homeowner} · {selectedSale.repName} · {selectedSale.routeName}</p>
              </div>

              <div>
                <label htmlFor="sales-editor-amount" className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-gray-400">Revenue (optional)</label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-green-400">$</span>
                  <Input
                    id="sales-editor-amount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={draft.amount}
                    onChange={(event) => { setDraft((current) => ({ ...current, amount: event.target.value })); setFormError(''); }}
                    disabled={draft.outcome !== SALE_OUTCOME || updateMutation.isPending || deleteMutation.isPending}
                    placeholder="No amount entered"
                    className="h-11 border-white/10 bg-black/40 pl-7 text-white"
                  />
                </div>
                {draft.outcome !== SALE_OUTCOME && <p className="mt-1 text-[10px] text-gray-500">Revenue will be cleared when this is changed from Sold.</p>}
              </div>

              <div>
                <label htmlFor="sales-editor-outcome" className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-gray-400">Outcome</label>
                <select
                  id="sales-editor-outcome"
                  value={draft.outcome}
                  onChange={(event) => { setDraft((current) => ({ ...current, outcome: event.target.value })); setFormError(''); }}
                  disabled={updateMutation.isPending || deleteMutation.isPending}
                  className="h-11 w-full rounded-md border border-white/10 bg-black/40 px-3 text-sm text-white outline-none focus:ring-1 focus:ring-green-400"
                >
                  {SALE_OUTCOME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {draft.outcome !== SALE_OUTCOME && <p className="mt-1 text-[10px] text-amber-300/80">Saving removes this record from Sales Manager but keeps it in interaction history.</p>}
              </div>

              <div>
                <label htmlFor="sales-editor-notes" className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-gray-400">Notes</label>
                <Textarea
                  id="sales-editor-notes"
                  value={draft.notes}
                  onChange={(event) => { setDraft((current) => ({ ...current, notes: event.target.value })); setFormError(''); }}
                  disabled={updateMutation.isPending || deleteMutation.isPending}
                  maxLength={1000}
                  placeholder="Add sale notes"
                  className="min-h-24 border-white/10 bg-black/40 text-white"
                />
              </div>

              {formError && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{formError}</p>}

              {confirmingDelete ? (
                <div role="alert" className="rounded-xl border border-red-400/25 bg-red-500/10 p-3">
                  <p className="text-xs font-black text-red-100">Delete this accidental sale?</p>
                  <p className="mt-1 text-[10px] text-red-200/75">This permanently removes the interaction record and cannot be undone.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" disabled={deleteMutation.isPending} onClick={() => setConfirmingDelete(false)} className="border-white/10 bg-black/20 text-white hover:bg-white/10">Cancel</Button>
                    <Button type="button" disabled={deleteMutation.isPending} onClick={deleteSale} className="bg-red-500 font-black text-white hover:bg-red-400">
                      {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
                    </Button>
                  </div>
                </div>
              ) : (
                <DialogFooter className="gap-2 sm:space-x-0">
                  <Button type="button" variant="outline" disabled={updateMutation.isPending || deleteMutation.isPending} onClick={() => setConfirmingDelete(true)} className="border-red-400/20 bg-red-500/10 text-red-200 hover:bg-red-500/20 hover:text-red-100 sm:mr-auto">
                    <Trash2 className="mr-1.5 h-4 w-4" /> Delete sale
                  </Button>
                  <Button type="button" variant="outline" disabled={updateMutation.isPending || deleteMutation.isPending} onClick={closeEditor} className="border-white/10 bg-white/[0.04] text-white hover:bg-white/10">Cancel</Button>
                  <Button type="button" disabled={updateMutation.isPending || deleteMutation.isPending} onClick={saveChanges} className="bg-green-400 font-black text-black hover:bg-green-300">
                    {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </DialogFooter>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
