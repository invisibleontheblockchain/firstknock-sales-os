import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { base44 } from '@/api/base44Client';
import { getNavigationPageNames, matchNavigationPage } from './navigationPageNames.js';

// Page names are enough for activity logging. Importing pages.config also loads
// every page component and defeats App's lazy route chunks on a cold start.
const pageNames = getNavigationPageNames(import.meta.glob('../pages/*.{jsx,js}'));

export default function NavigationTracker() {
    const location = useLocation();
    const { isAuthenticated } = useAuth();

    // Log user activity when navigating to a page
    useEffect(() => {
        const pageName = matchNavigationPage(location.pathname, pageNames);

        if (isAuthenticated && pageName) {
            base44.appLogs.logUserInApp(pageName).catch(() => {
                // Silently fail - logging shouldn't break the app
            });
        }
    }, [location, isAuthenticated]);

    return null;
}
