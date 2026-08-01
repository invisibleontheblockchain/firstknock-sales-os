import React from 'react';
import { Axe } from 'lucide-react';

/**
 * Yellow oval that sits beside the green home-value oval so a rep can spot a
 * brand-new build without opening the property.
 */
export default function NewBuildBadge({ className = '' }) {
    return (
        <span
            title="New construction — no prior owner on record"
            className={`inline-flex items-center gap-1 rounded-full border border-yellow-400/30 bg-yellow-400/10 px-1.5 py-0.5 font-bold text-yellow-300 ${className}`}
        >
            <Axe className="h-2.5 w-2.5" />NEW BUILD
        </span>
    );
}