import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

const DefaultFallback = () => (
  <div className="fixed inset-0 bg-black" aria-hidden="true" />
);

export default function ProtectedRoute({ fallback = <DefaultFallback />, unauthenticatedElement }) {
  const { isAuthenticated, isLoadingAuth, isLoadingPublicSettings, authError, checkAppState } = useAuth();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const loginElement = unauthenticatedElement || (
    <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />
  );

  if (isLoadingAuth || isLoadingPublicSettings) {
    return fallback;
  }

  if (authError) {
    if (authError.type === 'load_failed') {
      return (
        <div className="fixed inset-0 flex items-center justify-center bg-black p-6 text-center text-white">
          <div className="max-w-sm">
            <h1 className="text-xl font-bold">Unable to load your account</h1>
            <p className="mt-3 text-sm text-gray-400">Check your connection and try again. You do not need to refresh the app.</p>
            <button onClick={checkAppState} className="mt-5 rounded-xl bg-[#2EEB57] px-6 py-3 font-bold text-black">Try Again</button>
          </div>
        </div>
      );
    }
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
