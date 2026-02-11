import React from 'react';
import { Check, X as XIcon, Clock, Home } from 'lucide-react';

const ACTIONS = [
    { id: 'SOLD', label: 'SOLD', icon: Check, bg: '#22c55e', text: '#fff' },
    { id: 'HARD_NO', label: 'NO', icon: XIcon, bg: '#8B5CF6', text: '#fff' },
    { id: 'CALLBACK', label: 'LATER', icon: Clock, bg: '#eab308', text: '#000' },
    { id: 'NO_ANSWER', label: 'AWAY', icon: Home, bg: '#6b7280', text: '#fff' },
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
                            rounded-xl font-bold tracking-wide transition-all 
                            active:scale-90 disabled:opacity-40
                            flex flex-col items-center justify-center gap-1
                            shadow-lg
                        `}
                        style={{ background: a.bg, color: a.text }}
                    >
                        <Icon className={isLarge ? 'w-6 h-6' : 'w-5 h-5'} />
                        <span className={isLarge ? 'text-[11px]' : 'text-[9px]'}>{a.label}</span>
                    </button>
                );
            })}
        </div>
    );
}