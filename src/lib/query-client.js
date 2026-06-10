import { QueryClient } from '@tanstack/react-query';


export const queryClientInstance = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
			retry: 1,
			// Serve cached data for 30s before refetching on remount — cuts redundant
			// API calls from tab/component remounts at scale. Mutations still invalidate
			// their queries explicitly, and real-time subscriptions bypass staleTime.
			staleTime: 30 * 1000,
		},
	},
});