import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import { TileLayer, useMap } from 'react-leaflet';
import { createTileLoadingRecovery } from '@/components/map/tileLoadingRecovery';

function TileRecoveryNotice({ label, status, onRetry }) {
  const map = useMap();
  const [container, setContainer] = useState(null);

  useEffect(() => {
    const element = L.DomUtil.create('div', 'fk-tile-recovery');
    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
    const control = L.control({ position: 'bottomleft' });
    control.onAdd = () => element;
    control.addTo(map);
    setContainer(element);
    return () => control.remove();
  }, [map]);

  if (!container) return null;
  return createPortal(
    <div role="status" className="max-w-[240px] rounded-lg border border-white/20 bg-black/90 px-3 py-2 text-xs text-white shadow-lg">
      <p>{status.online ? `${label} could not finish loading.` : `${label} is waiting for a connection.`}</p>
      <button type="button" disabled={!status.online} onClick={onRetry} className="mt-2 min-h-[36px] rounded bg-[#2EEB57] px-3 py-1 font-bold text-black disabled:opacity-50">
        Retry tiles
      </button>
    </div>,
    container,
  );
}

export default function RecoveringTileLayer({ recoveryLabel = 'Map imagery', eventHandlers, ...props }) {
  const [status, setStatus] = useState({ failedCount: 0, online: navigator.onLine !== false });
  const recovery = useMemo(() => createTileLoadingRecovery({ onStatus: setStatus }), [props.url]);
  // Register recovery before React-Leaflet's passive effect adds its layer and
  // emits the first tileloadstart events, including StrictMode remounts.
  useLayoutEffect(() => {
    recovery.start();
    return () => recovery.dispose();
  }, [recovery]);
  const handlers = useMemo(() => {
    const merged = { ...eventHandlers };
    Object.entries(recovery.handlers).forEach(([event, handler]) => {
      merged[event] = value => { handler(value); eventHandlers?.[event]?.(value); };
    });
    return merged;
  }, [eventHandlers, recovery]);

  return (
    <>
      <TileLayer {...props} eventHandlers={handlers} />
      {status.failedCount > 0 && <TileRecoveryNotice label={recoveryLabel} status={status} onRetry={() => recovery.retryFailed()} />}
    </>
  );
}
