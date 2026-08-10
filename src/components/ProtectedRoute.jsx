import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

const DefaultFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

export default function ProtectedRoute({ fallback = <DefaultFallback />, unauthenticatedElement }) {
  const { isAuthenticated, isLoadingAuth, isLoadingPublicSettings, authError } = useAuth();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const loginElement = unauthenticatedElement || (
    <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />
  );

  if (isLoadingAuth || isLoadingPublicSettings) {
    return fallback;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    }
    return loginElement;
  }

  if (!isAuthenticated) {
    return loginElement;
  }

  return <Outlet />;
}