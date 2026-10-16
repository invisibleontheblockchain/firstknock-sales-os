import React from 'react';

export default function RoutePathLegend() {
    return (
        <span className="inline-flex items-center gap-1.5 text-[10px] text-white/80">
            <span aria-hidden="true" className="w-5 border-t-2 border-dashed" />
            Lines connect stops in order
        </span>
    );
}
