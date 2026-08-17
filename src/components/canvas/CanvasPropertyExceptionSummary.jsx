import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { getCanvasClassifiedProperties } from '@/components/canvas/canvasResidentialPresentation';

export default function CanvasPropertyExceptionSummary({ analysis }) {
  const review = getCanvasClassifiedProperties(analysis).filter((property) => property.canvass_eligibility === 'review');
  if (!review.length) return null;
  return <section className="space-y-2 rounded-2xl border border-amber-400/30 bg-amber-500/[0.08] p-3" aria-label="Property exceptions">
    <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="text-xs font-black text-amber-100">{review.length} propert{review.length === 1 ? 'y' : 'ies'} need evidence review</p><p className="mt-1 text-[10px] leading-relaxed text-amber-50/70">These addresses are excluded from workload until stronger property evidence resolves them. Streets remain connectivity only.</p></div></div>
    <div className="max-h-32 space-y-1 overflow-y-auto">{review.slice(0, 100).map((property) => <div key={property.fk_property_id || property.property_id} className="rounded-lg border border-amber-200/10 bg-black/20 px-2.5 py-2"><p className="truncate text-[10px] font-bold text-white">{property.display_address || property.normalized_address || property.fk_property_id}</p><p className="truncate text-[9px] text-amber-100/60">{property.classification_reasons?.join(' · ').replaceAll('_', ' ') || 'Property use unresolved'}</p></div>)}</div>
    {review.length > 100 && <p className="text-[9px] text-amber-100/60">Showing the first 100 exceptions; all are visible as amber property pins on the map.</p>}
  </section>;
}