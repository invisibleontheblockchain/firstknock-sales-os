import React from 'react';
import { Capacitor } from '@capacitor/core';
import { Navigate, useLocation } from 'react-router-dom';
import { getInstalledAppDestination } from '@/lib/installedAppLaunch';

const SatelliteLanding = React.lazy(() => import('@/components/marketing/SatelliteLanding'));

export default function AppEntry() {
  const { search, hash } = useLocation();
  const destination = getInstalledAppDestination({
    isNative: Capacitor.isNativePlatform(),
    search,
    hash,
  });

  // Older home-screen installs and native shells may still launch at /.
  // Decide before rendering so installed apps never load the marketing scene.
  return destination ? <Navigate to={destination} replace /> : <SatelliteLanding />;
}
