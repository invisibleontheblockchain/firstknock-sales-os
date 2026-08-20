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

// Phase 5 — code-splitting: every page in ./pages is its own lazy-loaded chunk.
// import.meta.glob bypasses the stale auto-generated pages.config.js — any new
// page file is auto-registered as a route and only downloaded when visited.
const pageModules = import.meta.glob('./pages/*.{jsx,js}');
const Pages = Object.fromEntries(
  Object.entries(pageModules).map(([path, loader]) => [
    path.replace(/^\.\/pages\//, '').replace(/\.(jsx|js)$/, ''),
    React.lazy(loader),
  ])
);

const mainPageKey = 'RoleSelect';
const MainPage = Pages[mainPageKey];

const LayoutWrapper = ({ children, currentPageName }) => Layout ?
  <Layout currentPageName={currentPageName}>{children}</Layout>
  : <>{children}</>;

function isPrivateHqAlias(pathname) {
  return String(pathname || '').replace(/\/+$/, '').toLowerCase() === '/hq';
}

function PrivateHqAliasRedirect() {
  React.useEffect(() => {
    const destination = `/hq/index.html${window.location.search}${window.location.hash}`;
    window.location.replace(destination);
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/10 border-t-[#39FF6E]" />
    </div>
  );
}

const AUTH_PAGE_KEYS = new Set(['Login', 'Register', 'ForgotPassword', 'ResetPassword']);

const RoutedApp = () => (
  <Routes>
    <Route path="/login" element={<Pages.Login />} />
    <Route path="/register" element={<Pages.Register />} />
    <Route path="/forgot-password" element={<Pages.ForgotPassword />} />
    <Route path="/reset-password" element={<Pages.ResetPassword />} />

    <Route element={<ProtectedRoute />}>
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <MainPage />
        </LayoutWrapper>
      } />
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
  if (typeof window !== 'undefined' && isPrivateHqAlias(window.location.pathname)) {
    return <PrivateHqAliasRedirect />;
  }

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <AppRefreshManager />
        <Router>
          <NavigationTracker />
          <React.Suspense fallback={
            <div className="fixed inset-0 flex items-center justify-center bg-black">
              <div className="w-8 h-8 border-4 border-slate-700 border-t-yellow-500 rounded-full animate-spin"></div>
            </div>
          }>
            <RoutedApp />
          </React.Suspense>
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