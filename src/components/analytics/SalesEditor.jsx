import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  DollarSign,
  Edit3,
  MapPin,
  Route,
  Sparkles,
  Trash2,
  TrendingUp,
  User,
} from 'lucide-react';
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
  const amount = Number(value);
  const fractionDigits = Number.isInteger(amount) ? 0 : 2;
  return amount.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
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
  const missingAmounts = sales.length - valuedSales;
  const averageDeal = valuedSales > 0 ? totalRevenue / valuedSales : 0;
  const revenueCoverage = sales.length > 0 ? Math.round((valuedSales / sales.length) * 100) : 0;

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
      <section
        aria-labelledby="sales-manager-title"
        className="relative isolate overflow-hidden rounded-[28px] border border-white/10 bg-black text-white shadow-[0_26px_90px_rgba(0,0,0,0.52)]"
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_-6%,rgba(46,235,87,0.18),transparent_30%),radial-gradient(circle_at_92%_4%,rgba(57,255,74,0.08),transparent_24%),linear-gradient(180deg,#080a08_0%,#030403_48%,#000000_100%)]" />
        <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#39FF4A]/70 to-transparent" />

        <div className="relative">
          <header className="border-b border-white/[0.08] px-3.5 pb-4 pt-4 sm:px-5 sm:pb-5 sm:pt-5 lg:px-7 lg:pb-6 lg:pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#2EEB57]/35 bg-[#2EEB57]/10 shadow-[0_0_24px_rgba(46,235,87,0.2)]">
                  <DollarSign className="h-5 w-5 text-[#39FF4A]" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="sales-manager-title" className="text-lg font-black tracking-tight text-white sm:text-xl">
                      Sales Manager
                    </h2>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#39FF4A]/25 bg-[#2EEB57]/10 px-2 py-1 text-[8px] font-black uppercase tracking-[0.16em] text-[#39FF4A]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#39FF4A] shadow-[0_0_9px_rgba(57,255,74,0.95)]" />
                      Live
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] font-medium text-white/45 sm:text-xs">
                    Every close, every dollar, one clean command center.
                  </p>
                </div>
              </div>

              <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white/45">
                <Sparkles className="h-3 w-3 text-[#39FF4A]" />
                Revenue command
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3">
              <div className="relative col-span-2 overflow-hidden rounded-2xl border border-[#2EEB57]/25 bg-[#2EEB57]/[0.08] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_16px_45px_rgba(46,235,87,0.08)] sm:p-5 lg:col-span-2">
                <div className="pointer-events-none absolute -right-10 -top-14 h-36 w-36 rounded-full bg-[#2EEB57]/10 blur-3xl" />
                <div className="relative flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#39FF4A]/70">
                      Recorded revenue
                    </p>
                    <p className="mt-1.5 break-all text-[clamp(1.65rem,8vw,2.65rem)] font-black leading-none tracking-[-0.05em] text-white tabular-nums">
                      {formatMoney(totalRevenue)}
                    </p>
                  </div>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#39FF4A]/20 bg-black/25 text-[#39FF4A]">
                    <TrendingUp className="h-4 w-4" />
                  </span>
                </div>
                <div className="relative mt-4">
                  <div className="flex items-center justify-between gap-3 text-[9px] font-bold text-white/40">
                    <span>Revenue captured</span>
                    <span className="font-black text-white/65">{revenueCoverage}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full border border-white/[0.06] bg-black/50">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#2EEB57] to-[#39FF4A] shadow-[0_0_14px_rgba(57,255,74,0.48)] transition-[width] duration-500"
                      style={{ width: `${revenueCoverage}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] sm:p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-black/30">
                  <CheckCircle2 className="h-4 w-4 text-[#39FF4A]" />
                </div>
                <p className="mt-4 text-2xl font-black tracking-tight text-white sm:text-3xl">{sales.length.toLocaleString()}</p>
                <p className="mt-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-white/35">Closed sales</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] sm:p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-black/30">
                  <DollarSign className="h-4 w-4 text-[#39FF4A]" />
                </div>
                <p className="mt-4 min-w-0 break-all text-[clamp(1.25rem,6vw,1.875rem)] font-black leading-tight tracking-tight text-white tabular-nums">
                  {valuedSales > 0 ? formatMoney(averageDeal) : '—'}
                </p>
                <p className="mt-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-white/35">Average deal</p>
              </div>
            </div>

            {missingAmounts > 0 && (
              <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2.5 text-[10px] text-amber-100/70 sm:items-center">
                <DollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300 sm:mt-0" />
                <p>
                  <span className="font-black text-amber-200">{missingAmounts} {missingAmounts === 1 ? 'sale needs' : 'sales need'} revenue.</span>
                  {' '}Open a deal to complete your totals.
                </p>
              </div>
            )}
          </header>

          <div className="px-3.5 pb-4 pt-4 sm:px-5 sm:pb-5 lg:px-7 lg:pb-7">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#39FF4A]/65">Deal ledger</p>
                <h3 className="mt-0.5 text-sm font-black text-white sm:text-base">Recent closes</h3>
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[9px] font-black text-white/45">
                {sales.length} {sales.length === 1 ? 'record' : 'records'}
              </span>
            </div>

            {sales.length === 0 ? (
              <div className="relative overflow-hidden rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-5 py-16 text-center">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(46,235,87,0.08),transparent_30%)]" />
                <div className="relative">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#2EEB57]/20 bg-[#2EEB57]/[0.07]">
                    <DollarSign className="h-5 w-5 text-[#39FF4A]/70" />
                  </div>
                  <p className="mt-4 text-sm font-black text-white">Your first close lands here</p>
                  <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-white/40">
                    Sales logged from Knock are organized here automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                {sales.map((sale, index) => (
                  <button
                    type="button"
                    key={sale.id}
                    onClick={() => openEditor(sale)}
                    aria-label={`Edit sale at ${sale.address}`}
                    className="group relative flex min-h-44 w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-3.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_36px_rgba(0,0,0,0.24)] transition-all duration-300 hover:-translate-y-0.5 hover:border-[#2EEB57]/35 hover:bg-[#2EEB57]/[0.055] hover:shadow-[0_18px_48px_rgba(0,0,0,0.38)] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#39FF4A] sm:p-4"
                  >
                    <span className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#2EEB57]/20 bg-[#2EEB57]/10 px-2 py-1 text-[8px] font-black uppercase tracking-[0.14em] text-[#39FF4A]">
                        Sale {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="flex min-w-0 items-center gap-1 text-right text-[9px] font-bold text-white/35">
                        <CalendarDays className="h-3 w-3 shrink-0" />
                        <span className="truncate">{formatSaleDate(sale.createdAt)}</span>
                      </span>
                    </div>

                    <div className="mt-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-[15px] font-extrabold leading-tight tracking-tight text-white transition-colors group-hover:text-[#39FF4A] sm:text-base">
                          {sale.address}
                        </p>
                        <p className="mt-1.5 flex min-w-0 items-start gap-1.5 text-[10px] text-white/40 sm:text-[11px]">
                          <User className="mt-px h-3 w-3 shrink-0 text-white/30" />
                          <span className="break-words">{sale.homeowner}</span>
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={`text-base font-black tracking-tight sm:text-lg ${sale.amountRecorded ? 'text-[#39FF4A]' : 'text-white/30'}`}>
                          {sale.amountRecorded ? formatMoney(sale.amount) : '—'}
                        </p>
                        <p className="mt-0.5 text-[8px] font-black uppercase tracking-[0.12em] text-white/25">
                          {sale.amountRecorded ? 'Revenue' : 'Add revenue'}
                        </p>
                      </div>
                    </div>

                    {sale.notes && (
                      <p className="mt-2 line-clamp-1 text-[10px] italic text-white/35">
                        “{sale.notes}”
                      </p>
                    )}

                    <div className="mt-auto flex items-end justify-between gap-3 pt-3">
                      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-white/[0.07] bg-black/25 px-2 py-1 text-[9px] font-bold text-white/45">
                          <User className="h-2.5 w-2.5 shrink-0 text-[#39FF4A]/75" />
                          <span className="truncate">{sale.repName}</span>
                        </span>
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-white/[0.07] bg-black/25 px-2 py-1 text-[9px] font-bold text-white/45">
                          <Route className="h-2.5 w-2.5 shrink-0 text-[#39FF4A]/75" />
                          <span className="truncate">{sale.routeName}</span>
                        </span>
                      </div>

                      <span className="flex min-h-10 shrink-0 items-center gap-1 rounded-xl border border-[#2EEB57]/20 bg-[#2EEB57]/10 px-2.5 text-[9px] font-black uppercase tracking-[0.08em] text-[#39FF4A] transition-colors group-hover:border-[#2EEB57]/45 group-hover:bg-[#2EEB57] group-hover:text-black">
                        Edit
                        <ChevronRight className="h-3 w-3" />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <Dialog open={!!selectedSale} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogContent className="bottom-0 left-0 top-auto flex max-h-[92dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-[2rem] border-x-0 border-b-0 border-t border-white/10 bg-[#050505]/95 p-0 text-white shadow-[0_-24px_80px_rgba(0,0,0,0.76)] backdrop-blur-2xl [&>button]:flex [&>button]:h-10 [&>button]:w-10 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-xl [&>button]:border [&>button]:border-white/10 [&>button]:bg-white/[0.04] sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:max-h-[88dvh] sm:w-[calc(100%_-_2rem)] sm:max-w-xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-[28px] sm:border">
          <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#39FF4A]/70 to-transparent" />

          <DialogHeader className="shrink-0 border-b border-white/[0.08] px-4 pb-4 pt-5 text-left sm:px-6 sm:pb-5 sm:pt-6">
            <div className="flex items-center gap-3 pr-8">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[#2EEB57]/30 bg-[#2EEB57]/10 shadow-[0_0_20px_rgba(46,235,87,0.15)]">
                <Edit3 className="h-4 w-4 text-[#39FF4A]" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-left text-lg font-black tracking-tight">Edit sale</DialogTitle>
                <DialogDescription className="mt-1 text-left text-[11px] text-white/40">
                  Keep revenue and outcome details accurate.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {selectedSale && (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
                <div className="relative overflow-hidden rounded-2xl border border-[#2EEB57]/20 bg-[#2EEB57]/[0.07] p-3.5">
                  <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-[#2EEB57]/10 blur-2xl" />
                  <div className="relative flex items-start gap-2.5">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#39FF4A]" />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-black text-white">{selectedSale.address}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[9px] font-bold text-white/40">
                        <span>{selectedSale.homeowner}</span>
                        <span className="text-white/15">•</span>
                        <span>{selectedSale.repName}</span>
                        <span className="text-white/15">•</span>
                        <span>{selectedSale.routeName}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="sales-editor-amount" className="mb-1.5 block text-[9px] font-black uppercase tracking-[0.14em] text-white/45">
                      Revenue <span className="normal-case tracking-normal text-white/25">(optional)</span>
                    </label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-black text-[#39FF4A]">$</span>
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
                        className="h-12 rounded-xl border-white/10 bg-white/[0.045] pl-8 text-base font-bold text-white placeholder:text-white/25 focus-visible:ring-[#39FF4A]"
                      />
                    </div>
                    {draft.outcome !== SALE_OUTCOME && (
                      <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">Revenue clears when the outcome is no longer Sold.</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="sales-editor-outcome" className="mb-1.5 block text-[9px] font-black uppercase tracking-[0.14em] text-white/45">
                      Outcome
                    </label>
                    <select
                      id="sales-editor-outcome"
                      value={draft.outcome}
                      onChange={(event) => { setDraft((current) => ({ ...current, outcome: event.target.value })); setFormError(''); }}
                      disabled={updateMutation.isPending || deleteMutation.isPending}
                      className="h-12 w-full rounded-xl border border-white/10 bg-white/[0.045] px-3.5 text-sm font-bold text-white outline-none transition focus:border-[#39FF4A]/50 focus:ring-1 focus:ring-[#39FF4A]"
                    >
                      {SALE_OUTCOME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    {draft.outcome !== SALE_OUTCOME && (
                      <p className="mt-1.5 text-[10px] leading-relaxed text-amber-200/70">Saving keeps the interaction in history but removes it from Sales Manager.</p>
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <label htmlFor="sales-editor-notes" className="mb-1.5 block text-[9px] font-black uppercase tracking-[0.14em] text-white/45">
                    Deal notes
                  </label>
                  <Textarea
                    id="sales-editor-notes"
                    value={draft.notes}
                    onChange={(event) => { setDraft((current) => ({ ...current, notes: event.target.value })); setFormError(''); }}
                    disabled={updateMutation.isPending || deleteMutation.isPending}
                    maxLength={1000}
                    placeholder="Add context for this close"
                    className="min-h-28 resize-none rounded-xl border-white/10 bg-white/[0.045] text-sm text-white placeholder:text-white/25 focus-visible:ring-[#39FF4A]"
                  />
                </div>

                {formError && (
                  <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2.5 text-xs text-red-100">
                    {formError}
                  </p>
                )}

              </div>

              <div className="shrink-0 border-t border-white/[0.08] bg-black/70 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl sm:px-6 sm:pb-5 sm:pt-4">
                {confirmingDelete ? (
                  <div role="alert" className="rounded-2xl border border-red-400/25 bg-red-500/10 p-3">
                    <p className="text-xs font-black text-red-100">Delete this accidental sale?</p>
                    <p className="mt-1 text-[10px] leading-relaxed text-red-100/60">
                      This permanently removes the interaction record and cannot be undone.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={deleteMutation.isPending}
                        onClick={() => setConfirmingDelete(false)}
                        className="min-h-11 rounded-xl border-white/10 bg-black/20 font-bold text-white hover:bg-white/10 hover:text-white"
                      >
                        Keep sale
                      </Button>
                      <Button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={deleteSale}
                        className="min-h-11 rounded-xl bg-red-500 font-black text-white hover:bg-red-400"
                      >
                        {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                    <Button
                      type="button"
                      disabled={updateMutation.isPending || deleteMutation.isPending}
                      onClick={saveChanges}
                      className="order-1 col-span-2 min-h-12 rounded-xl bg-[#2EEB57] font-black text-black shadow-[0_0_20px_rgba(46,235,87,0.18)] hover:bg-[#39FF4A] sm:order-3 sm:ml-0 sm:min-h-11 sm:px-5"
                    >
                      {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={updateMutation.isPending || deleteMutation.isPending}
                      onClick={() => setConfirmingDelete(true)}
                      className="order-3 min-h-11 rounded-xl border-red-400/20 bg-red-500/[0.07] text-red-200 hover:bg-red-500/15 hover:text-red-100 sm:order-1 sm:mr-auto"
                    >
                      <Trash2 className="mr-1.5 h-4 w-4" /> Delete
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={updateMutation.isPending || deleteMutation.isPending}
                      onClick={closeEditor}
                      className="order-2 min-h-11 rounded-xl border-white/10 bg-white/[0.04] font-bold text-white hover:bg-white/10 hover:text-white"
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
