import React from 'react';
import { Check, Users, Target } from 'lucide-react';

export default function PricingModeCard({ mode, title, price, subtitle, features = [], usage }) {
  const isCanvas = mode === 'canvas';
  const accentClasses = isCanvas
    ? 'border-purple-500/50 bg-purple-950/20 text-purple-300'
    : 'border-yellow-500/50 bg-yellow-950/20 text-yellow-300';
  const Icon = isCanvas ? Users : Target;

  return (
    <div className={`rounded-2xl border p-5 ${accentClasses}`}>
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-black/40 flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-extrabold text-white">{title}</h3>
          <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
        </div>
      </div>

      <div className="mb-4">
        <span className="text-3xl font-extrabold text-white">{price}</span>
      </div>

      {usage && (
        <div className="mb-4 rounded-xl bg-black/40 border border-white/10 p-3">
          <div className="flex items-center justify-between text-xs font-bold mb-2">
            <span className="text-gray-400">Precision Properties</span>
            <span className="text-white">{usage.remaining.toLocaleString()} left</span>
          </div>
          <div className="h-2 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full bg-yellow-500" style={{ width: `${usage.percent}%` }} />
          </div>
          <p className="text-[10px] text-gray-500 mt-2">
            {usage.used.toLocaleString()} used of {usage.limit.toLocaleString()} included properties.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-gray-300">
            <Check className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}