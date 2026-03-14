import React from 'react';
import { Check, Home, Phone, Ban } from 'lucide-react';

const ACTIONS = [
    { id: 'SOLD', label: 'SOLD', icon: Check, bg: 'rgba(34, 197, 94, 0.1)', text: '#22c55e', border: 'rgba(34, 197, 94, 0.2)' },
    { id: 'NO_ANSWER', label: 'NO ANSWER', icon: Home, bg: 'rgba(59, 130, 246, 0.1)', text: '#3b82f6', border: 'rgba(59, 130, 246, 0.2)' },
    { id: 'CALLBACK', label: 'CALLBACK', icon: Phone, bg: 'rgba(234, 179, 8, 0.1)', text: '#eab308', border: 'rgba(234, 179, 8, 0.2)' },
    { id: 'HARD_NO', label: 'NOT INT.', icon: Ban, bg: 'rgba(139, 92, 246, 0.1)', text: '#8B5CF6', border: 'rgba(139, 92, 246, 0.2)' },
];

export default function QuickMarkButtons({ onMark, disabled, size = 'normal' }) {
    const isLarge = size === 'large';
    
    return (
        <div className={`grid grid-cols-4 ${isLarge ? 'gap-3' : 'gap-2'}`}>
            {ACTIONS.map(a => {
                const Icon = a.icon;
                return (
                    <button
                        key={a.id}
                        onClick={() => onMark(a.id)}
                        disabled={disabled}
                        className={`
                            ${isLarge ? 'h-16' : 'h-12'} 
                            rounded-xl font-bold tracking-wide transition-all duration-200
                            hover:-translate-y-1 active:scale-95 disabled:opacity-40
                            flex flex-col items-center justify-center gap-1
                            backdrop-blur-md
                        `}
                        style={{ background: a.bg, color: a.text, border: `1px solid ${a.border}`, boxShadow: `0 4px 15px ${a.bg}` }}
                    >
                        <Icon className={isLarge ? 'w-5 h-5' : 'w-4 h-4'} strokeWidth={3} />
                        <span className={isLarge ? 'text-[10px]' : 'text-[8px]'} style={{ letterSpacing: '0.05em' }}>{a.label}</span>
                    </button>
                );
            })}
        </div>
    );
}