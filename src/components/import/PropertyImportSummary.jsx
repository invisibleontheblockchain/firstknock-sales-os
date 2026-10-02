import React from 'react';
import Papa from 'papaparse';
import { FileSpreadsheet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function PropertyImportSummary({ importBatch, route, preview, isSaving, progress, isLoading, error, onSave, onCancel, onNameChange }) {
  if (!importBatch) return null;
  const adding = !!importBatch.routeId;
  const { summary, skippedRows } = importBatch;
  const downloadSkipped = () => {
    const url = URL.createObjectURL(new Blob([Papa.unparse(skippedRows, { escapeFormulae: true })], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${importBatch.fileName.replace(/\.[^.]+$/, '')}-skipped.csv`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="fixed inset-0 z-[6000] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={isSaving ? undefined : onCancel}>
      <div role="dialog" aria-modal="true" aria-labelledby="property-import-title" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-green-500/25 bg-[#111113] text-white shadow-2xl sm:rounded-3xl" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-white/10 p-5">
          <div className="flex items-start gap-3 min-w-0">
            <FileSpreadsheet className="mt-1 h-6 w-6 shrink-0 text-green-400" />
            <div className="min-w-0">
              <h2 id="property-import-title" className="text-lg font-bold">Review Import</h2>
              <p className="mt-1 break-all text-xs text-gray-400">{importBatch.fileName}</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} disabled={isSaving} aria-label="Cancel import" className="rounded-full p-2 hover:bg-white/10 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 p-5 text-sm">
          {adding ? (
            <p>Add to <strong>{route?.name || 'selected route'}</strong>. We will check the full route, including existing stops, and automatically apply a better order when available. Assignment and visit history are preserved.</p>
          ) : (
            <label className="block text-xs text-gray-400">New route name
              <input value={importBatch.routeName} onChange={event => onNameChange(event.target.value)} disabled={isSaving} className="mt-2 w-full rounded-lg border border-white/15 bg-black/30 p-3 text-sm text-white" />
            </label>
          )}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
            <p className="font-semibold text-green-400">{summary.ready.toLocaleString()} properties located</p>
            <p className="text-gray-400">{summary.duplicatesRemoved.toLocaleString()} duplicate {summary.duplicatesRemoved === 1 ? 'row' : 'rows'} removed from file</p>
            <p className="text-gray-400">{summary.skipped.toLocaleString()} rows skipped</p>
            {adding && preview && <>
              <p className="text-gray-400">{preview.duplicatesRemoved.toLocaleString()} {preview.duplicatesRemoved === 1 ? 'property' : 'properties'} already on this route</p>
              <p className="font-semibold">{preview.additions.length.toLocaleString()} new stops · {preview.propertyHashes.length.toLocaleString()} total stops</p>
            </>}
            {isLoading && <p className="text-yellow-400">Checking existing route stops...</p>}
          </div>
          {!!skippedRows.length && <div className="rounded-xl border border-yellow-500/20 p-3 text-xs text-yellow-300">
            <p className="font-semibold">Review skipped addresses</p>
            <ul className="mt-2 space-y-2">
              {skippedRows.slice(0, 3).map((row, index) => <li key={index}>{row.address || `Row ${row.row}`}: {row.reason}</li>)}
            </ul>
            <button type="button" onClick={downloadSkipped} className="mt-3 underline">Download all skipped rows</button>
          </div>}
          {progress && <p role="status" aria-live="polite" className="text-xs text-yellow-400">{progress}</p>}
          {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-2 border-t border-white/10 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          <Button variant="outline" onClick={onCancel} disabled={isSaving} className="h-11 rounded-xl">Cancel</Button>
          <Button onClick={onSave} disabled={isSaving || isLoading || (adding && !preview) || (!adding && !importBatch.routeName.trim())} className="h-11 flex-1 rounded-xl bg-green-500 font-bold text-black hover:bg-green-400">
            {isSaving ? 'Saving...' : adding ? (preview?.additions.length === 0 ? 'Open Existing Route' : 'Add to Route') : 'Create Route'}
          </Button>
        </div>
      </div>
    </div>
  );
}
