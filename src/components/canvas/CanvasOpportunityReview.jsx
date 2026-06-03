import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, Eye, Loader2, Trees, Building2 } from 'lucide-react';

const EXCLUDED_LABELS = {
  parks: 'Parks',
  forests: 'Forests',
  schools: 'Schools',
  waters: 'Water',
  golfCourses: 'Golf Courses',
  industrialAreas: 'Industrial Areas',
  commercialAreas: 'Commercial Areas'
};

export default function CanvasOpportunityReview({ analysis, loading, onAnalyze, onFeedback, hasDrawnArea }) {
  const excludedEntries = Object.entries(analysis?.excluded || {}).filter(([, value]) => Number(value) > 0);
  const confidence = analysis?.confidence || { high: 0, medium: 0, low: 0 };
  const total = Number(analysis?.totalOpportunities || 0);

  return (
    <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-black text-emerald-300 tracking-widest uppercase flex items-center gap-2"><Eye className="w-4 h-4" /> Review Opportunities</p>
          <p className="text-[11px] text-emerald-100/70">Buildings minus excluded land — Canvas only.</p>
        </div>
        <Button onClick={onAnalyze} disabled={!hasDrawnArea || loading} size="sm" className="bg-emerald-600 hover:bg-emerald-500 text-white">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />} Analyze
        </Button>
      </div>

      {!hasDrawnArea && <p className="text-[11px] text-gray-400">Draw a Canvas territory before analyzing opportunities.</p>}

      {analysis && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-black/35 border border-white/10 p-4">
            <p className="text-3xl font-black text-white">{total.toLocaleString()}</p>
            <p className="text-xs font-bold text-emerald-300 uppercase">Opportunities Found</p>
            <p className="text-[11px] text-gray-400 mt-1">Green dots on the map show discovered building opportunities.</p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric label="High" value={confidence.high || 0} tone="text-green-300" />
            <Metric label="Medium" value={confidence.medium || 0} tone="text-yellow-300" />
            <Metric label="Low" value={confidence.low || 0} tone="text-slate-300" />
          </div>

          <div className="rounded-xl bg-black/30 border border-white/10 p-3 space-y-2">
            <p className="text-xs font-black text-red-300 flex items-center gap-2"><Trees className="w-4 h-4" /> Excluded Areas</p>
            {excludedEntries.length ? (
              <div className="flex flex-wrap gap-2">
                {excludedEntries.map(([key, value]) => (
                  <Badge key={key} className="bg-red-500/15 text-red-200 border border-red-500/25">
                    {value} {EXCLUDED_LABELS[key] || key}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-gray-400">No excluded parks, schools, forests, water, golf, commercial, or industrial areas found.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => onFeedback?.('looks_correct')} className="bg-green-600 hover:bg-green-500 text-white">
              <CheckCircle2 className="w-4 h-4" /> Looks Correct
            </Button>
            <Button onClick={() => onFeedback?.('looks_incorrect')} className="bg-red-600/20 hover:bg-red-600/30 text-red-200 border border-red-500/30">
              <XCircle className="w-4 h-4" /> Looks Incorrect
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="rounded-xl bg-black/30 border border-white/10 p-3">
      <p className={`text-lg font-black ${tone}`}>{Number(value || 0).toLocaleString()}</p>
      <p className="text-[10px] font-bold text-gray-500 uppercase">{label}</p>
    </div>
  );
}