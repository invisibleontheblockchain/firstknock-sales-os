import React from 'react';
import { FileSpreadsheet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function RedfinImportSummary({ importBatch, isSaving, onCreateRoute, onCancel }) {
  if (!importBatch) return null;
  const { summary, routeName } = importBatch;

  return (
    <div className="fixed inset-0 z-[6000] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-t-3xl border border-[#2EEB57]/25 bg-[#070707] text-white shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-white/10 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#2EEB57]/25 bg-[#2EEB57]/10">
              <FileSpreadsheet className="h-5 w-5 text-[#39FF4A]" />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#39FF4A]">Redfin CSV detected</p>
              <h2 className="mt-1 text-lg font-black text-white">Import Summary</h2>
              <p className="mt-1 text-xs text-white/50">Route: <span className="font-bold text-white">{routeName}</span></p>
            </div>
          </div>
          <button onClick={onCancel} className="flex h-9 w-9 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white" aria-label="Cancel import">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <SummaryRow label={`${summary.ready.toLocaleString()} properties ready to import`} tone="green" />
          <SummaryRow label={`${summary.skippedMissingAddress.toLocaleString()} rows skipped (missing address)`} />
          <SummaryRow label={`${summary.duplicatesRemoved.toLocaleString()} duplicates removed`} />
        </div>

        <div className="flex gap-2 border-t border-white/10 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving} className="h-11 flex-1 rounded-xl">
            Cancel
          </Button>
          <Button type="button" onClick={onCreateRoute} disabled={isSaving} className="h-11 flex-1 rounded-xl bg-[#2EEB57] font-black text-black hover:bg-[#39FF4A]">
            {isSaving ? 'Creating...' : 'Create Route'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, tone }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <span className="text-sm font-bold text-white">{label}</span>
      <span className={`h-2.5 w-2.5 rounded-full ${tone === 'green' ? 'bg-[#2EEB57]' : 'bg-white/30'}`} />
    </div>
  );
}