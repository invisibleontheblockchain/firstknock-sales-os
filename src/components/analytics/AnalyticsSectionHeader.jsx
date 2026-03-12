import React from 'react';

export default function AnalyticsSectionHeader({ eyebrow, title, description }) {
  return (
    <div className="space-y-1">
      {eyebrow && (
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500">
          {eyebrow}
        </p>
      )}
      <div className="space-y-1">
        <h2 className="text-lg md:text-xl font-black text-white tracking-tight">{title}</h2>
        {description && <p className="text-sm text-gray-400 max-w-3xl">{description}</p>}
      </div>
    </div>
  );
}