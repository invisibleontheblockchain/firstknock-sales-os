import { useAuth, useUser, SignIn, SignUp, UserButton } from '@clerk/clerk-react';

// API helper with auth token
export function useAuthenticatedFetch() {
    const { getToken } = useAuth();

    return async (url, options = {}) => {
        const token = await getToken();
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';

        return fetch(`${apiUrl}${url}`, {
            ...options,
            headers: {
                ...options.headers,
                'Content-Type': 'application/json',
                ...(token && { Authorization: `Bearer ${token}` }),
            },
        });
    };
}

// Re-export Clerk components for convenience
export { useAuth, useUser, SignIn, SignUp, UserButton };
