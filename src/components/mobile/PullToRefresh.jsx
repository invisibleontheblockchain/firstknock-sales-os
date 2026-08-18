import React from 'react';
import { Loader2 } from 'lucide-react';

export default function PullToRefresh({ children, onRefresh, className = '', threshold = 72 }) {
  const containerRef = React.useRef(null);
  const startYRef = React.useRef(0);
  const [pullDistance, setPullDistance] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);

  const canPull = () => containerRef.current && containerRef.current.scrollTop <= 0 && !refreshing;

  const handleTouchStart = (event) => {
    if (!canPull()) return;
    startYRef.current = event.touches[0].clientY;
  };

  const handleTouchMove = (event) => {
    if (!canPull() || !startYRef.current) return;
    const distance = event.touches[0].clientY - startYRef.current;
    if (distance > 0) setPullDistance(Math.min(distance * 0.55, threshold + 28));
  };

  const handleTouchEnd = async () => {
    if (pullDistance >= threshold && onRefresh) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
    setPullDistance(0);
    startYRef.current = 0;
  };

  const visible = refreshing || pullDistance > 0;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ WebkitOverflowScrolling: 'touch' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        className="pointer-events-none flex items-center justify-center overflow-hidden transition-[height] duration-200"
        style={{ height: visible ? Math.max(refreshing ? 48 : pullDistance, 0) : 0 }}
      >
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 text-[10px] font-bold text-white/70 shadow-lg backdrop-blur-xl">
          <Loader2 className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-[#2EEB57]' : 'text-white/50'}`} />
          {refreshing ? 'Refreshing' : pullDistance >= threshold ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      </div>
      {children}
    </div>
  );
}