import React from 'react';
import { Check, X as XIcon, Clock, Home } from 'lucide-react';

const ACTIONS = [
    { id: 'SOLD', label: 'INTERESTED', icon: Check, bg: 'rgba(0, 245, 160, 0.1)', text: '#00F5A0', border: 'rgba(0, 245, 160, 0.2)' },
    { id: 'NO_ANSWER', label: 'NOT HOME', icon: Home, bg: 'rgba(136, 136, 160, 0.1)', text: '#8888A0', border: 'rgba(136, 136, 160, 0.2)' },
    { id: 'CALLBACK', label: 'FOLLOW UP', icon: Clock, bg: 'rgba(255, 217, 61, 0.1)', text: '#FFD93D', border: 'rgba(255, 217, 61, 0.2)' },
    { id: 'HARD_NO', label: 'NOT INT.', icon: XIcon, bg: 'rgba(255, 107, 107, 0.1)', text: '#FF6B6B', border: 'rgba(255, 107, 107, 0.2)' },
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