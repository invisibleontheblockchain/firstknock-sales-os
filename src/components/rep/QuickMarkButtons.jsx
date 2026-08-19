import React from 'react';
import { Check, Home, Phone, Ban, Clock, UserX } from 'lucide-react';

const ACTIONS = [
    { id: 'SOLD', label: 'SOLD', icon: Check, bg: 'rgba(46, 235, 87, 0.12)', text: '#39FF4A', border: 'rgba(46, 235, 87, 0.3)' },
    { id: 'NO_ANSWER', label: 'NO ANSWER', icon: Home, bg: 'rgba(255, 255, 255, 0.055)', text: '#FFFFFF', border: 'rgba(255, 255, 255, 0.12)' },
    { id: 'CALLBACK', label: 'CALLBACK', icon: Phone, bg: 'rgba(168, 85, 247, 0.12)', text: '#C084FC', border: 'rgba(168, 85, 247, 0.35)' },
    { id: 'HARD_NO', label: 'NOT INT.', icon: Ban, bg: 'rgba(255, 107, 107, 0.1)', text: '#FF6B6B', border: 'rgba(255, 107, 107, 0.24)' },
    { id: 'NOT_MOVED_IN', label: 'NOT MOVED IN', icon: Clock, bg: 'rgba(255, 160, 51, 0.1)', text: '#FFA033', border: 'rgba(255, 160, 51, 0.24)' },
    { id: 'DM_NOT_HOME', label: 'DM NOT HOME', icon: UserX, bg: 'rgba(255, 255, 255, 0.055)', text: '#FFFFFF', border: 'rgba(255, 255, 255, 0.14)' },
];

export default function QuickMarkButtons({ onMark, disabled, size = 'normal' }) {
    const isLarge = size === 'large';
    
    return (
        <div className={`grid grid-cols-3 ${isLarge ? 'gap-3' : 'gap-2'}`}>
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