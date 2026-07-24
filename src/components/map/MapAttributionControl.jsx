import { useLayoutEffect } from 'react';
import { useMap } from 'react-leaflet';

/**
 * Leaflet's renderer credit is optional UI chrome. Tile/data-provider credit is
 * not, so keep the provider attribution while removing the Leaflet prefix and
 * applying FirstKnock's compact map treatment.
 */
export default function MapAttributionControl({
  position = 'bottomright',
  bottomOffset = 0,
}) {
  const map = useMap();

  useLayoutEffect(() => {
    const control = map?.attributionControl;
    const container = control?.getContainer?.();
    if (!control || !container) return undefined;
    const safePosition = position === 'bottomleft' ? 'bottomleft' : 'bottomright';
    const safeBottomOffset = Math.min(
      600,
      Math.max(0, Number(bottomOffset) || 0),
    );
    const previousPosition = control.getPosition();
    const previousTransform = container.style.transform;

    control.setPrefix(false);
    control.setPosition(safePosition);
    container.classList.add('fk-map-attribution');
    container.style.transform = safeBottomOffset
      ? `translateY(-${safeBottomOffset}px)`
      : '';
    container.setAttribute('aria-label', 'Map data attribution');

    return () => {
      control.setPosition(previousPosition);
      container.classList.remove('fk-map-attribution');
      container.style.transform = previousTransform;
      container.removeAttribute('aria-label');
    };
  }, [bottomOffset, map, position]);

  return null;
}
