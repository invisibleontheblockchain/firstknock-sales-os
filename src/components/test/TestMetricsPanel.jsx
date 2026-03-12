import React from 'react';
import { Clock, Activity, BarChart3, AlertTriangle, Zap } from 'lucide-react';

export default function TestMetricsPanel({ metrics }) {
  if (!metrics) return null;

  const duration = metrics.totalDurationMs
    ? (metrics.totalDurationMs / 1000).toFixed(1)
    : null;

  const avgChunk = metrics.chunkTimings && metrics.chunkTimings.length > 0
    ? (metrics.chunkTimings.reduce((a, b) => a + b, 0) / metrics.chunkTimings.length).toFixed(1)
    : null;

  const cards = [
    {
      label: 'Total Time',
      value: duration ? `${duration}s` : 'Running...',
      sub: avgChunk ? `Avg chunk: ${avgChunk}s` : '',
      icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/10'
    },
    {
      label: 'API Calls',
      value: metrics.apiCalls || 0,
      sub: metrics.mlsApiCalls ? `MLS: ${metrics.mlsApiCalls}` : '',
      icon: Zap, color: 'text-yellow-400', bg: 'bg-yellow-500/10'
    },
    {
      label: 'Records Found',
      value: metrics.totalFetched || metrics.totalFound || 0,
      sub: metrics.totalExpected ? `Expected: ${metrics.totalExpected}` : '',
      icon: BarChart3, color: 'text-purple-400', bg: 'bg-purple-500/10'
    },
    {
      label: 'Inserted',
      value: metrics.inserted || 0,
      sub: metrics.existed ? `Already existed: ${metrics.existed}` : '',
      icon: Activity, color: 'text-green-400', bg: 'bg-green-500/10'
    },
  ];

  if (metrics.source === 'area') {
    cards.push({
      label: 'MLS Found',
      value: metrics.mlsFetched || 0,
      sub: metrics.mlsNew ? `${metrics.mlsNew} new (not in deeds)` : '',
      icon: Activity, color: 'text-cyan-400', bg: 'bg-cyan-500/10'
    });
  }

  if (metrics.source === 'zip') {
    cards.push({
      label: 'Sold / MLS',
      value: `${metrics.soldCount || 0} / ${metrics.mlsCount || 0}`,
      sub: '',
      icon: Activity, color: 'text-cyan-400', bg: 'bg-cyan-500/10'
    });
  }

  if (metrics.errorCount > 0) {
    cards.push({
      label: 'Errors',
      value: metrics.errorCount,
      sub: 'Check console for details',
      icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/10'
    });
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Metrics</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {cards.map((c, i) => (
          <div key={i} className={`rounded-xl ${c.bg} border border-white/5 p-3`}>
            <c.icon className={`w-4 h-4 ${c.color} mb-1.5`} />
            <p className="text-lg font-black text-white leading-none">{c.value}</p>
            <p className="text-[10px] font-bold text-gray-400 mt-1">{c.label}</p>
            {c.sub && <p className="text-[9px] text-gray-600 mt-0.5">{c.sub}</p>}
          </div>
        ))}
      </div>

      {/* Chunk timing chart */}
      {metrics.chunkTimings && metrics.chunkTimings.length > 1 && (
        <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3">
          <p className="text-[10px] font-bold text-gray-500 mb-2">CHUNK DURATIONS (seconds)</p>
          <div className="flex items-end gap-1 h-16">
            {metrics.chunkTimings.map((t, i) => {
              const max = Math.max(...metrics.chunkTimings);
              const h = max > 0 ? (t / max) * 100 : 50;
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <span className="text-[8px] text-gray-600">{t}s</span>
                  <div
                    className="w-full rounded-t bg-gradient-to-t from-blue-600 to-blue-400 min-h-[2px]"
                    style={{ height: `${h}%` }}
                  />
                  <span className="text-[8px] text-gray-700">#{i + 1}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error log */}
      {metrics.errors && metrics.errors.length > 0 && (
        <div className="rounded-xl bg-red-500/5 border border-red-500/20 p-3">
          <p className="text-[10px] font-bold text-red-400 mb-2">ERROR LOG ({metrics.errors.length})</p>
          <div className="space-y-1 max-h-32 overflow-auto">
            {metrics.errors.map((e, i) => (
              <p key={i} className="text-[10px] text-red-300/70 font-mono break-all">{e}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}