import React from 'react';
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import NavigationTracker from '@/lib/NavigationTracker'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import AppRefreshManager from '@/components/AppRefreshManager';
import Layout from './Layout.jsx';
import { RepLocationProvider } from '@/components/team/RepLocationSharing';
import { AutoDrivingProvider } from '@/components/team/AutoDrivingTracking';
import RoadAwareComparisonHost from '@/components/routes/RoadAwareComparisonHost';
import RoadOptimizationProgressHost from '@/components/routes/RoadOptimizationProgressHost';
import { isHqPath } from '@/admin/hqNavigation';
import { pageNameForPath, preloadPage, registerPageLoaders } from '@/lib/pagePreload';
import { appParams } from '@/lib/app-params';
import { preconnectMapHosts } from '@/lib/mapTileWarmup';

// Phase 5 — code-splitting: every page in ./pages is its own lazy-loaded chunk.
// import.meta.glob bypasses the stale auto-generated pages.config.js — any new
// page file is auto-registered as a route and only downloaded when visited.
const pageModules = import.meta.glob('./pages/*.{jsx,js}');
const pageLoaders = Object.fromEntries(
  Object.entries(pageModules).map(([path, loader]) => [
    path.replace(/^\.\/pages\//, '').replace(/\.(jsx|js)$/, ''),
    loader,
  ])
);
const Pages = Object.fromEntries(
  Object.entries(pageLoaders).map(([name, loader]) => [name, React.lazy(loader)])
);
registerPageLoaders(pageLoaders);
// Only a signed-in device will render this page; others are sent to sign in.
if (typeof window !== 'undefined' && appParams.token && !isHqPath(window.location.pathname)) {
  const initialPage = pageNameForPath(window.location.pathname);
  preloadPage(initialPage);
  preconnectMapHosts(initialPage);
}

const AppEntry = React.lazy(() => import('@/components/AppEntry'));
const AdminApp = React.lazy(() => import('@/admin/AdminApp'));

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

// Pages served without authentication: the auth screens plus the public /find
// acquisition page that ad traffic lands on.
const AUTH_PAGE_KEYS = new Set(['Login', 'Register', 'ForgotPassword', 'ResetPassword', 'Find']);

const RoutedApp = () => (
  <Routes>
    <Route path="/" element={<AppEntry />} />
    <Route path="/login" element={<Pages.Login />} />
    <Route path="/register" element={<Pages.Register />} />
    <Route path="/forgot-password" element={<Pages.ForgotPassword />} />
    <Route path="/reset-password" element={<Pages.ResetPassword />} />
    {/* Public acquisition landing for ad traffic — no login wall. */}
    <Route path="/find" element={<Pages.Find />} />

    <Route element={<ProtectedRoute />}>
      {Object.entries(Pages)
        .filter(([path]) => !AUTH_PAGE_KEYS.has(path))
        .map(([path, Page]) => (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <LayoutWrapper currentPageName={path}>
                <Page />
              </LayoutWrapper>
            }
          />
        ))}
      <Route path="*" element={<PageNotFound />} />
    </Route>
  </Routes>
);


function App() {
  // Base44 serves the main entry for nested HTML paths, including installed
  // HQ apps. Render the dashboard here instead of redirecting into a 404.
  if (typeof window !== 'undefined' && isHqPath(window.location.pathname)) {
    return (
      <QueryClientProvider client={queryClientInstance}>
        <React.Suspense fallback={<div className="fixed inset-0 bg-black" aria-hidden="true" />}>
          <AdminApp />
        </React.Suspense>
      </QueryClientProvider>
    );
  }

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <AppRefreshManager />
        <RoadAwareComparisonHost />
        <RoadOptimizationProgressHost />
        <Router>
          <AutoDrivingProvider>
          <RepLocationProvider>
            <NavigationTracker />
            <React.Suspense fallback={
              <div className="fixed inset-0 bg-black" aria-hidden="true" />
            }>
              <RoutedApp />
            </React.Suspense>
          </RepLocationProvider>
          </AutoDrivingProvider>
        </Router>
        <Toaster />
        {/* visibleToasts={1} keeps stacked/duplicate notifications from piling up —
            a newer toast replaces the one on screen instead of showing beside it. */}
        <SonnerToaster richColors closeButton visibleToasts={1} />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
