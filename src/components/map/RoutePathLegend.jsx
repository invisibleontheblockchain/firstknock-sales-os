import React from 'react';

export default function RoutePathLegend({ hasDrivingGeometry }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[10px] text-white/80">
            <span aria-hidden="true" className={`w-5 border-t-2 ${hasDrivingGeometry ? 'border-solid' : 'border-dashed'}`} />
            {hasDrivingGeometry ? 'Driving path' : 'Stop order only · Driving path not available'}
        </span>
    );
}
