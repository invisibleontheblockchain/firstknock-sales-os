import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';

const { appId, token, appBaseUrl } = appParams;

//Create a client with authentication required
// Functions intentionally use the current deployment. Base44 preview version
// pins can outlive a preview and pair this UI with an older function contract.
export const base44 = createClient({
  appId,
  token,
  serverUrl: '',
  requiresAuth: false,
  appBaseUrl
});

if (typeof window !== 'undefined') {
  /** @type {Window & { base44?: unknown }} */ (window).base44 = base44;
}
