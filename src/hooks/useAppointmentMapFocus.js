import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * Appointment deep links from the Appointments tab.
 *
 * The link carries the saved route, the address hash, and the coordinates, so the
 * map can open the route, zoom to the door, and select it. The map instance can
 * still be mounting when the link resolves, so the zoom retries briefly instead
 * of being silently skipped.
 */
export default function useAppointmentMapFocus({
  savedRoutes,
  activeRoute,
  effectiveProperties,
  mapRef,
  setMode,
  setShowRoutePanel,
  setShowCompare,
  setSelectedProperty,
  setAppointmentPin,
}) {
  const handledRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('appointment') !== '1' || handledRef.current) return;

    const savedRouteId = params.get('savedRoute');
    const routeExistsHere = savedRouteId && savedRoutes.some((route) => route.id === savedRouteId);
    if (routeExistsHere && !activeRoute) return;

    const focusHash = params.get('focus');
    const lat = Number(params.get('lat'));
    const lng = Number(params.get('lng'));
    const hasValidLatLng = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001;
    const address = params.get('address') || 'Appointment address';
    const routeProps = activeRoute?.properties || activeRoute?.allProperties || [];
    const target = [...routeProps, ...effectiveProperties].find((property) => focusHash && (
      property.address_hash === focusHash || property.legacy_hash === focusHash || property.id === focusHash
    )) || (hasValidLatLng ? {
      id: focusHash || `appointment-${lat}-${lng}`,
      address_hash: focusHash || `appointment-${lat}-${lng}`,
      full_address: address,
      address,
      house_number: '',
      street_name: address,
      lat,
      lng,
      effective_status: 'CALLBACK',
    } : null);

    handledRef.current = true;
    setMode('analyze');
    setShowRoutePanel(false);
    setShowCompare(false);
    toast.dismiss('appointment-map');

    const targetLat = Number(target?.lat);
    const targetLng = Number(target?.lng);
    if (Number.isFinite(targetLat) && Number.isFinite(targetLng) && Math.abs(targetLat) > 0.0001 && Math.abs(targetLng) > 0.0001) {
      const focused = { ...target, lat: targetLat, lng: targetLng };
      setSelectedProperty(focused);
      // The pin outlives the detail card so the door stays clickable on the map
      // even when its route is not loaded.
      setAppointmentPin?.(focused);
      let attempts = 0;
      const zoomToAppointment = () => {
        if (mapRef.current?._mapPane) {
          try { mapRef.current.setView([targetLat, targetLng], 18, { animate: true }); } catch { }
          return;
        }
        if (attempts++ < 20) setTimeout(zoomToAppointment, 200);
      };
      zoomToAppointment();
    } else {
      toast.error("Couldn't find this appointment on the map yet.");
    }
    window.history.replaceState({}, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute, effectiveProperties, savedRoutes]);
}