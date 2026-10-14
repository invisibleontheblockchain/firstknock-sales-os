import React from 'react';
import { OUTCOME_OPTIONS, outcomeBorder, outcomeTint } from '@/components/logic/outcomeStatus';

export default function QuickMarkButtons({ onMark, disabled, size = 'normal' }) {
    const isLarge = size === 'large';
    
    return (
        <div className={`grid grid-cols-2 ${isLarge ? 'gap-3' : 'gap-2'}`}>
            {OUTCOME_OPTIONS.map(a => {
                const Icon = a.icon;
                return (
                    <button
                        key={a.id}
                        onClick={() => onMark(a.id)}
                        disabled={disabled}
                        className={`
                            ${a.id === 'SOLD' ? 'col-span-2 h-16' : isLarge ? 'h-16' : 'h-12'}
                            rounded-xl font-bold tracking-wide transition-all duration-200
                            hover:-translate-y-1 active:scale-95 disabled:opacity-40
                            flex ${a.id === 'SOLD' ? 'flex-row gap-2' : 'flex-col gap-1'} items-center justify-center
                            backdrop-blur-md
                        `}
                        style={{ background: outcomeTint(a.color, '18'), color: a.color, border: `1px solid ${outcomeBorder(a.color, '40')}`, boxShadow: `0 4px 15px ${outcomeTint(a.color, '18')}` }}
                    >
                        <Icon className={isLarge ? 'w-5 h-5' : 'w-4 h-4'} strokeWidth={3} />
                        <span className={a.id === 'SOLD' ? 'text-sm font-black' : 'text-[10px]'} style={{ letterSpacing: '0.05em' }}>{a.label.toUpperCase()}</span>
                    </button>
                );
            })}
        </div>
    );
}
