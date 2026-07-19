import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plug,
  RefreshCw,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import {
  disconnectFieldRoutes,
  getFieldRoutesCapability,
  listFieldRoutesActivity,
  listFieldRoutesServiceTypes,
  retryFieldRoutesRequest,
  saveFieldRoutesConnection,
  testFieldRoutesConnection,
} from '@/api/fieldRoutes';
import { createPageUrl } from '@/utils';
import { isManagerAccount } from '@/lib/roles';
import { fieldRoutesSetupAccess } from '@/components/fieldroutes/fieldRoutesManagerSetup';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PRODUCTION_DOMAIN = 'fieldroutes.com';
const STAGING_HOST = 'stagingdemo.pestroutes.com';
const ACTIVITY_LIMIT = 20;
const VERIFIED_CONNECTION_STATES = new Set(['connected', 'ready', 'verified', 'healthy']);

const ACTIVITY_STATUS = Object.freeze({
  synced: { label: 'Synced', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' },
  completed: { label: 'Completed', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' },
  superseded: { label: 'Superseded by corrected request', className: 'border-slate-500/30 bg-slate-500/10 text-slate-200' },
  queued: { label: 'Queued', className: 'border-sky-500/30 bg-sky-500/10 text-sky-200' },
  pending: { label: 'Pending', className: 'border-sky-500/30 bg-sky-500/10 text-sky-200' },
  processing: { label: 'Processing', className: 'border-sky-500/30 bg-sky-500/10 text-sky-200' },
  retry_wait: { label: 'Retry scheduled', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
  retrying: { label: 'Retrying', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
  customer_reconcile: { label: 'Checking customer', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
  appointment_reconcile: { label: 'Checking appointment', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
  review_required: { label: 'Review required', className: 'border-orange-500/30 bg-orange-500/10 text-orange-200' },
  needs_review_customer_match: { label: 'Review customer', className: 'border-orange-500/30 bg-orange-500/10 text-orange-200' },
  needs_review_ambiguous: { label: 'Review appointment', className: 'border-orange-500/30 bg-orange-500/10 text-orange-200' },
  blocked_auth: { label: 'Reconnect required', className: 'border-red-500/30 bg-red-500/10 text-red-200' },
  blocked_config: { label: 'Fix setup', className: 'border-red-500/30 bg-red-500/10 text-red-200' },
  failed_permanent: { label: 'Needs correction', className: 'border-red-500/30 bg-red-500/10 text-red-200' },
  failed: { label: 'Needs attention', className: 'border-red-500/30 bg-red-500/10 text-red-200' },
  needs_attention: { label: 'Needs attention', className: 'border-red-500/30 bg-red-500/10 text-red-200' },
  ambiguous: { label: 'Review required', className: 'border-orange-500/30 bg-orange-500/10 text-orange-200' },
});

const ACTIVITY_ERROR_LABELS = Object.freeze({
  authentication_failed: 'Saved credentials were rejected. Reconnect FieldRoutes.',
  invalid_credentials: 'Saved credentials were rejected. Reconnect FieldRoutes.',
  provider_authentication_failed: 'Saved credentials were rejected. Reconnect FieldRoutes.',
  rate_limited: 'FieldRoutes is rate limited. Retry after the provider cooldown.',
  provider_rate_limited: 'FieldRoutes is rate limited. FirstKnock will retry after the provider cooldown.',
  provider_unavailable: 'FieldRoutes was unavailable when this request ran.',
  provider_timeout: 'FieldRoutes did not confirm the request. FirstKnock will retry or reconcile it safely.',
  provider_network_error: 'FieldRoutes could not be reached. FirstKnock will retry safely.',
  provider_server_error: 'FieldRoutes could not confirm the request. FirstKnock will retry safely.',
  provider_invalid_json: 'FieldRoutes returned an unreadable response.',
  provider_validation_failed: 'FieldRoutes rejected the inspection details.',
  provider_request_rejected: 'FieldRoutes rejected this request.',
  provider_create_id_invalid: 'FieldRoutes did not confirm the created record. Review before retrying.',
  ambiguous_write: 'FieldRoutes may have accepted this appointment. Review it before retrying.',
  customer_create_unconfirmed: 'FirstKnock is checking whether FieldRoutes created this customer.',
  appointment_create_unconfirmed: 'FirstKnock is checking whether FieldRoutes created this appointment.',
  ambiguous_customer_match: 'Multiple possible FieldRoutes customers require manager review.',
  customer_match_missing_address_data: 'The possible FieldRoutes customer could not be safely verified.',
  customer_link_address_conflict: 'The linked FieldRoutes customer does not match this address.',
  ambiguous_appointment_match: 'Multiple possible FieldRoutes appointments require manager review.',
  retry_window_expired: 'The automatic retry window expired. Review before retrying.',
  request_not_retryable: 'This request must be reviewed manually.',
  service_type_invalid: 'The selected service type is no longer available.',
  fieldroutes_service_type_required: 'Choose a valid initial service type in the integration setup.',
});

const REVIEW_ACTIVITY_STATES = new Set([
  'ambiguous',
  'needs_attention',
  'review_required',
  'needs_review_customer_match',
  'needs_review_ambiguous',
  'blocked_auth',
  'blocked_config',
  'failed_permanent',
]);

const PAYLOAD_CORRECTION_REQUIRED_CODES = new Set([
  'provider_validation_failed',
  'retry_window_expired',
]);

const RECONCILIATION_CHECKPOINTS = new Set([
  'customer_create_ambiguous',
  'appointment_create_ambiguous',
]);

function requiresReconciliationConfirmation(item, activityState, errorCode) {
  const checkpoint = normalizeStatus(item?.checkpoint);
  return activityState === 'review_required'
    || RECONCILIATION_CHECKPOINTS.has(checkpoint)
    || /ambiguous|unconfirmed/.test(errorCode);
}

function isStagingEnvironment(value) {
  return value === 'staging' || value === 'legacy_staging';
}

function normalizeIdentifier(value) {
  return String(value ?? '').trim();
}

function capabilityHostSubdomain(capability) {
  if (isStagingEnvironment(capability?.environment)) return '';
  try {
    const rawHost = String(
      capability?.account_host
      || (capability?.subdomain ? `${capability.subdomain}.${PRODUCTION_DOMAIN}` : '')
    ).trim();
    const hostname = new URL(/^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`).hostname;
    if (!hostname.endsWith(`.${PRODUCTION_DOMAIN}`)) return '';
    return hostname.slice(0, -(PRODUCTION_DOMAIN.length + 1)).split('.')[0] || '';
  } catch {
    return '';
  }
}

function safeCapabilityHost(capability, fallback) {
  if (isStagingEnvironment(capability?.environment)) return STAGING_HOST;
  const subdomain = capabilityHostSubdomain(capability);
  return subdomain ? `${subdomain}.${PRODUCTION_DOMAIN}` : fallback;
}

function normalizeServiceType(item) {
  const id = normalizeIdentifier(item?.service_type_id ?? item?.type_id ?? item?.typeID ?? item?.id);
  if (!id) return null;
  const visibleValue = item?.visible;
  const visible = visibleValue === undefined || visibleValue === null || visibleValue === true || Number(visibleValue) === 1;
  const initial = item?.initial === true || Number(item?.initial) === 1;
  const defaultLength = Number(item?.default_length ?? item?.defaultLength ?? 0);
  return {
    id,
    name: String(item?.service_type_name ?? item?.name ?? item?.description ?? `Service type ${id}`).trim(),
    visible,
    initial,
    defaultLength: Number.isFinite(defaultLength) && defaultLength > 0 ? Math.round(defaultLength) : null,
  };
}

function extractServiceTypes(result) {
  const candidate = Array.isArray(result)
    ? result
    : result?.service_types || result?.serviceTypes || result?.serviceTypeIDs || result?.items || [];
  const values = Array.isArray(candidate)
    ? candidate
    : candidate && typeof candidate === 'object'
      ? Object.values(candidate)
      : [];
  return values
    .map(normalizeServiceType)
    .filter((item) => item?.visible)
    .sort((a, b) => Number(b.initial) - Number(a.initial) || a.name.localeCompare(b.name));
}

function extractActivity(result) {
  const rows = Array.isArray(result)
    ? result
    : result?.activity || result?.requests || result?.items || [];
  return Array.isArray(rows) ? rows.slice(0, ACTIVITY_LIMIT) : [];
}

function normalizeStatus(value) {
  return String(value || 'pending').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

function activityStatus(value) {
  const normalized = normalizeStatus(value);
  return ACTIVITY_STATUS[normalized] || {
    label: 'In progress',
    className: 'border-white/15 bg-white/5 text-white/70',
  };
}

function safeSourceMode(value) {
  const normalized = normalizeStatus(value);
  if (normalized === 'canvas') return 'Canvas';
  if (normalized === 'precision') return 'Precision';
  if (normalized === 'manual') return 'Manual';
  if (normalized === 'rep') return 'Rep';
  return 'FirstKnock';
}

function safeServerLabel(value, fallback = '') {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (/(?:authentication|api|access)\s*(?:key|token)|(?:key|token|secret|password)\s*[:=]|[?&](?:authenticationKey|authenticationToken|apiKey)=|[a-z0-9_-]{48,}/i.test(text)) {
    return 'Sensitive provider details were redacted. Review the saved connection.';
  }
  return text.slice(0, 180);
}

function activityError(item) {
  const code = normalizeStatus(item?.error_code || item?.last_error_code || item?.code);
  return safeServerLabel(
    item?.error_label || item?.display_error,
    ACTIVITY_ERROR_LABELS[code] || (code ? 'FirstKnock could not complete this request. Review it before retrying.' : '')
  );
}

function formatTimestamp(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function ReadinessItem({ ready, children }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full ${ready ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-white/35'}`}>
        {ready ? <Check className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className={ready ? 'text-white/85' : 'text-white/45'}>{children}</span>
    </li>
  );
}

function LoadingPage() {
  return (
    <div className="flex h-full items-center justify-center bg-black text-white">
      <Loader2 className="h-7 w-7 animate-spin text-[#39FF4A]" />
    </div>
  );
}

function ManagerOnlyMessage() {
  return (
    <div className="h-full overflow-y-auto bg-black p-4 text-white sm:p-8">
      <Card className="mx-auto mt-12 max-w-xl border-amber-500/25 bg-amber-500/[0.06] hover:translate-y-0 hover:border-amber-500/25">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <ShieldAlert className="h-10 w-10 text-amber-300" />
          <div>
            <h1 className="text-xl font-bold">Manager access required</h1>
            <p className="mt-2 text-sm text-white/55">Only a team manager or account owner can configure company integrations.</p>
          </div>
          <Button asChild variant="outline" className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white">
            <Link to={createPageUrl('RepHome')}>Return to Knock Mode</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Integrations() {
  const queryClient = useQueryClient();
  const [environment, setEnvironment] = React.useState('production');
  const [subdomain, setSubdomain] = React.useState('');
  const [authenticationKey, setAuthenticationKey] = React.useState('');
  const [authenticationToken, setAuthenticationToken] = React.useState('');
  const [sourceId, setSourceId] = React.useState('');
  const [serviceTypeId, setServiceTypeId] = React.useState('');
  const [serviceTypeName, setServiceTypeName] = React.useState('');
  const [defaultLength, setDefaultLength] = React.useState('');
  const [serviceTypes, setServiceTypes] = React.useState([]);

  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: () => base44.auth.me(),
    retry: false,
  });
  const managerAllowed = isManagerAccount(userQuery.data);

  const capabilityQuery = useQuery({
    queryKey: ['fieldRoutesCapability'],
    queryFn: getFieldRoutesCapability,
    enabled: managerAllowed,
    retry: false,
    staleTime: 15_000,
  });

  const capability = capabilityQuery.data || {};
  const configured = capability.configured === true;
  const configuredServiceTypeId = capability.service_type_id ?? capability.default_service_type_id;
  const configReady = capability.config_ready === true
    || (configured && capability.connected === true && Boolean(configuredServiceTypeId));
  const canvasEnabled = capability.canvas_enabled === true || capability.modes?.canvas === true;
  const connectionStatus = normalizeStatus(capability.connection_status || capability.status);
  const connectionVerified = VERIFIED_CONNECTION_STATES.has(connectionStatus);
  const credentialsSaved = configured && connectionStatus !== 'disconnected';

  const activityQuery = useQuery({
    queryKey: ['fieldRoutesActivity'],
    queryFn: () => listFieldRoutesActivity({ limit: ACTIVITY_LIMIT }),
    enabled: managerAllowed && capabilityQuery.isSuccess && capability.enabled !== false && configured,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const activityRows = React.useMemo(() => extractActivity(activityQuery.data), [activityQuery.data]);
  const rateBudget = React.useMemo(() => {
    const capabilityBudget = capability?.rate_budget?.token_usage || capability?.rate_budget || capability?.token_usage;
    if (capabilityBudget && typeof capabilityBudget === 'object') return capabilityBudget;
    const today = new Date().toISOString().slice(0, 10);
    const latestToday = activityRows.find((row) => (
      String(row?.updated_at || row?.created_at || '').slice(0, 10) === today
      && row?.token_usage && typeof row.token_usage === 'object'
    ));
    return latestToday?.token_usage || null;
  }, [activityRows, capability]);
  const readsToday = Number(rateBudget?.readsToday ?? rateBudget?.reads_today ?? 0);
  const writesToday = Number(rateBudget?.writesToday ?? rateBudget?.writes_today ?? 0);
  const rateBudgetWarning = readsToday > 2500 || writesToday > 2500;

  React.useEffect(() => {
    if (!capabilityQuery.data) return;
    const nextEnvironment = isStagingEnvironment(capability.environment) ? 'staging' : 'production';
    setEnvironment(nextEnvironment);
    setSubdomain(capabilityHostSubdomain(capability));
    setSourceId(normalizeIdentifier(capability.source_id));
    setServiceTypeId(normalizeIdentifier(configuredServiceTypeId));
    setServiceTypeName(String(capability.service_type_name || capability.default_service_type_name || capability.name || '').trim());
    const length = Number(capability.default_length ?? capability.appointment_duration_minutes);
    setDefaultLength(Number.isFinite(length) && length > 0 ? String(Math.round(length)) : '');
  }, [capabilityQuery.data]);

  const refreshIntegrationQueries = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['fieldRoutesCapability'] }),
      queryClient.invalidateQueries({ queryKey: ['fieldRoutesActivity'] }),
    ]);
  }, [queryClient]);

  const loadServiceTypesMutation = useMutation({
    mutationFn: () => listFieldRoutesServiceTypes({ visible_only: true, initial_first: true }),
    onSuccess: (result) => {
      const next = extractServiceTypes(result);
      setServiceTypes(next);
      if (next.length === 0) {
        toast.info('No visible FieldRoutes service types were returned for this office.');
      } else {
        toast.success(`${next.length} visible service type${next.length === 1 ? '' : 's'} loaded.`);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const saveMutation = useMutation({
    mutationFn: saveFieldRoutesConnection,
    onSuccess: async () => {
      setAuthenticationKey('');
      setAuthenticationToken('');
      toast.success('FieldRoutes connection saved. Credentials are now hidden.');
      await refreshIntegrationQueries();
    },
    onError: (error) => toast.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: testFieldRoutesConnection,
    onSuccess: async (result) => {
      toast.success('FieldRoutes accepted the saved connection.');
      const embeddedTypes = extractServiceTypes(result);
      if (embeddedTypes.length > 0) setServiceTypes(embeddedTypes);
      await refreshIntegrationQueries();
      if (embeddedTypes.length === 0) loadServiceTypesMutation.mutate();
    },
    onError: (error) => toast.error(error.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectFieldRoutes,
    onSuccess: async () => {
      setAuthenticationKey('');
      setAuthenticationToken('');
      setSourceId('');
      setServiceTypeId('');
      setServiceTypeName('');
      setDefaultLength('');
      setServiceTypes([]);
      toast.success('FieldRoutes disconnected. Saved credentials were removed.');
      await refreshIntegrationQueries();
    },
    onError: (error) => toast.error(error.message),
  });

  const retryMutation = useMutation({
    mutationFn: ({ requestId }) => retryFieldRoutesRequest({ request_id: requestId }),
    onSuccess: async (_result, variables) => {
      toast.success(variables?.reconciliation
        ? 'The reviewed request was queued for safe reconciliation.'
        : 'The request was queued to retry.');
      await queryClient.invalidateQueries({ queryKey: ['fieldRoutesActivity'] });
    },
    onError: (error) => toast.error(error.message),
  });

  const serviceTypeOptions = React.useMemo(() => {
    if (!serviceTypeId || serviceTypes.some((item) => item.id === serviceTypeId)) return serviceTypes;
    return [{
      id: serviceTypeId,
      name: serviceTypeName || `Configured service type ${serviceTypeId}`,
      visible: true,
      initial: true,
      defaultLength: Number(defaultLength) || null,
    }, ...serviceTypes];
  }, [defaultLength, serviceTypeId, serviceTypeName, serviceTypes]);

  const setupAccess = fieldRoutesSetupAccess({
    capabilityLoading: capabilityQuery.isLoading,
    capabilitySucceeded: capabilityQuery.isSuccess,
    capabilityEnabled: capability.enabled,
    savePending: saveMutation.isPending,
  });

  const handleServiceTypeChange = (value) => {
    setServiceTypeId(value);
    const selected = serviceTypeOptions.find((item) => item.id === value);
    if (!selected) return;
    setServiceTypeName(selected.name);
    if (selected.defaultLength) setDefaultLength(String(selected.defaultLength));
  };

  const handleSave = (event) => {
    event.preventDefault();
    if (setupAccess.explicitlyDisabled) return toast.error('FieldRoutes is not enabled for this account yet.');

    const normalizedSubdomain = subdomain.trim().toLowerCase();
    if (environment === 'production' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedSubdomain)) {
      return toast.error('Enter only the account subdomain, such as “acme-pest”.');
    }

    const hasKey = authenticationKey.trim().length > 0;
    const hasToken = authenticationToken.trim().length > 0;
    if (hasKey !== hasToken) return toast.error('Enter both credentials together when connecting or rotating them.');
    if (!credentialsSaved && !hasKey) return toast.error('Enter both FieldRoutes credentials to connect this account.');

    const normalizedLength = Number(defaultLength);
    if (defaultLength && (!Number.isInteger(normalizedLength) || normalizedLength < 5 || normalizedLength > 480)) {
      return toast.error('Default appointment length must be between 5 and 480 minutes.');
    }

    const selected = serviceTypeOptions.find((item) => item.id === serviceTypeId);
    const payload = {
      environment: environment === 'staging' ? 'legacy_staging' : 'production',
      subdomain: environment === 'staging' ? 'stagingdemo' : normalizedSubdomain,
      office_id: null,
      source_id: sourceId.trim() || null,
      service_type_id: serviceTypeId || null,
      service_type_name: selected?.name || serviceTypeName || null,
      default_length: defaultLength ? normalizedLength : null,
      ...(hasKey ? {
        authentication_key: authenticationKey.trim(),
        authentication_token: authenticationToken.trim(),
      } : {}),
    };
    saveMutation.mutate(payload);
  };

  if (userQuery.isLoading) return <LoadingPage />;
  if (!managerAllowed) return <ManagerOnlyMessage />;

  const accountHost = environment === 'staging'
    ? STAGING_HOST
    : subdomain.trim()
      ? `${subdomain.trim().toLowerCase()}.${PRODUCTION_DOMAIN}`
      : `your-account.${PRODUCTION_DOMAIN}`;
  const displayedHost = safeCapabilityHost(capability, accountHost);
  const statusPresentation = configReady
    ? { label: 'Ready for reps', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' }
    : connectionVerified
      ? { label: 'Connected · finish setup', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' }
      : connectionStatus === 'error'
        ? { label: 'Reconnect required', className: 'border-red-500/30 bg-red-500/10 text-red-200' }
      : connectionStatus === 'disconnected'
        ? { label: 'Disconnected', className: 'border-white/15 bg-white/5 text-white/60' }
      : configured
        ? { label: 'Saved · test required', className: 'border-sky-500/30 bg-sky-500/10 text-sky-200' }
        : { label: 'Not connected', className: 'border-white/15 bg-white/5 text-white/60' };

  return (
    <div className="h-full overflow-y-auto bg-black text-white">
      <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link to={createPageUrl('Setup')} className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-white/45 transition-colors hover:text-white">
              <ArrowLeft className="h-3.5 w-3.5" /> Account setup
            </Link>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#39FF4A]/25 bg-[#39FF4A]/10 text-[#39FF4A]">
                <Plug className="h-5 w-5" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-extrabold sm:text-3xl">Integrations</h1>
                  <Badge className="border-white/15 bg-white/5 text-[10px] text-white/55">MANAGER ONLY</Badge>
                </div>
                <p className="mt-1 text-sm text-white/50">Connect your office tools without changing how reps knock.</p>
              </div>
            </div>
          </div>
          <a
            href="https://api.fieldroutes.com/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/45 transition-colors hover:text-white"
          >
            FieldRoutes API documentation <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        {capabilityQuery.isError && (
          <Alert className="border-red-500/30 bg-red-500/[0.08] text-red-100">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>Integration status is unavailable</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-red-100/70">
              <span>{capabilityQuery.error?.message || 'FirstKnock could not load the FieldRoutes capability.'}</span>
              <Button size="sm" variant="outline" onClick={() => capabilityQuery.refetch()} className="border-red-300/25 bg-transparent text-red-100 hover:bg-red-500/10 hover:text-red-50">
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {capabilityQuery.isSuccess && setupAccess.explicitlyDisabled && (
          <Alert className="border-amber-500/30 bg-amber-500/[0.08] text-amber-100">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>FieldRoutes is not enabled for this account</AlertTitle>
            <AlertDescription className="text-amber-100/70">
              Contact FirstKnock support to enable the integration before entering provider credentials.
            </AlertDescription>
          </Alert>
        )}

        {rateBudgetWarning && (
          <Alert className="border-amber-500/30 bg-amber-500/[0.08] text-amber-100">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>FieldRoutes API budget is running high</AlertTitle>
            <AlertDescription className="text-amber-100/70">
              FieldRoutes reported {Number.isFinite(readsToday) ? readsToday.toLocaleString() : '—'} reads and {Number.isFinite(writesToday) ? writesToday.toLocaleString() : '—'} writes today. Automatic retries will respect provider limits; contact FieldRoutes support if this account regularly approaches its daily allowance.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
          <Card className="border-white/10 bg-[#0D0D0D] hover:translate-y-0 hover:border-white/15">
            <CardHeader className="border-b border-white/8 pb-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
                    <Route className="h-5 w-5" />
                  </span>
                  <div>
                    <CardTitle className="text-lg">FieldRoutes</CardTitle>
                    <p className="mt-1 max-w-xl text-sm leading-6 text-white/50">
                      Send a rep’s scheduled inspection into the company FieldRoutes account, then let office staff route it.
                    </p>
                  </div>
                </div>
                <Badge className={statusPresentation.className}>{statusPresentation.label}</Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <form onSubmit={handleSave} className="space-y-6">
                <section className="space-y-3">
                  <div>
                    <h2 className="text-sm font-bold">1. Choose the account environment</h2>
                    <p className="mt-1 text-xs text-white/45">Production uses the subdomain from your normal FieldRoutes sign-in URL. Staging uses the exact FieldRoutes demo host.</p>
                  </div>
                  <Select value={environment} onValueChange={setEnvironment} disabled={setupAccess.controlsDisabled}>
                    <SelectTrigger className="h-11 border-white/10 bg-black/40 text-white focus:ring-[#39FF4A]/40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-white/10 bg-[#111] text-white">
                      <SelectItem value="production">Production company account</SelectItem>
                      <SelectItem value="staging">FieldRoutes staging demo</SelectItem>
                    </SelectContent>
                  </Select>

                  {environment === 'production' ? (
                    <div className="space-y-2">
                      <Label htmlFor="fieldroutes-subdomain" className="text-xs text-white/65">Account subdomain</Label>
                      <div className="flex overflow-hidden rounded-md border border-white/10 bg-black/40 focus-within:border-[#39FF4A]/40">
                        <Input
                          id="fieldroutes-subdomain"
                          value={subdomain}
                          onChange={(event) => setSubdomain(event.target.value)}
                          placeholder="acme-pest"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          disabled={setupAccess.controlsDisabled}
                          className="h-11 border-0 bg-transparent text-white focus-visible:ring-0"
                        />
                        <span className="flex items-center border-l border-white/10 px-3 text-xs text-white/35">.{PRODUCTION_DOMAIN}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.06] px-4 py-3">
                      <p className="text-xs font-semibold text-sky-100">Exact staging host</p>
                      <p className="mt-1 break-all font-mono text-xs text-sky-200/70">https://{STAGING_HOST}/api/</p>
                    </div>
                  )}
                </section>

                <section className="space-y-3 border-t border-white/8 pt-6">
                  <div>
                    <h2 className="text-sm font-bold">2. Save write-only credentials</h2>
                    <p className="mt-1 text-xs text-white/45">Credentials go directly to the FirstKnock server. They are never stored in this browser or displayed again.</p>
                  </div>
                  {credentialsSaved && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-xs text-emerald-100/80">
                      <LockKeyhole className="h-4 w-4 text-emerald-300" />
                      Credentials are saved. Leave both fields blank to keep them, or enter both to rotate them.
                    </div>
                  )}
                  {capabilityQuery.isError && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs leading-5 text-amber-100/75">
                      <p className="font-bold text-amber-100">FirstKnock server status needs attention</p>
                      <p className="mt-1">You can enter these details while status is unavailable. They stay on this page until you select Save, and a successful server response is still required before anything is stored.</p>
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="fieldroutes-api-key" className="text-xs text-white/65">API key</Label>
                      <div className="relative">
                        <KeyRound className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-white/25" />
                        <Input
                          id="fieldroutes-api-key"
                          type="password"
                          value={authenticationKey}
                          onChange={(event) => setAuthenticationKey(event.target.value)}
                          placeholder={credentialsSaved ? 'Saved · enter to replace' : 'Enter API key'}
                          autoComplete="new-password"
                          disabled={setupAccess.controlsDisabled}
                          className="h-11 border-white/10 bg-black/40 pl-10 text-white placeholder:text-white/25 focus-visible:ring-[#39FF4A]/40"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="fieldroutes-auth-token" className="text-xs text-white/65">Authentication token</Label>
                      <div className="relative">
                        <KeyRound className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-white/25" />
                        <Input
                          id="fieldroutes-auth-token"
                          type="password"
                          value={authenticationToken}
                          onChange={(event) => setAuthenticationToken(event.target.value)}
                          placeholder={credentialsSaved ? 'Saved · enter to replace' : 'Enter authentication token'}
                          autoComplete="new-password"
                          disabled={setupAccess.controlsDisabled}
                          className="h-11 border-white/10 bg-black/40 pl-10 text-white placeholder:text-white/25 focus-visible:ring-[#39FF4A]/40"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.06] px-4 py-3 text-xs leading-5 text-sky-100/75">
                      <p className="font-bold text-sky-100">Phase 1 uses one FieldRoutes office</p>
                      <p className="mt-1">Use an office-scoped API key. Global-key and multi-office routing stay disabled until the customer’s write contract passes staging.</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="fieldroutes-source-id" className="text-xs text-white/65">Lead source ID <span className="text-white/30">· optional</span></Label>
                      <Input
                        id="fieldroutes-source-id"
                        value={sourceId}
                        onChange={(event) => setSourceId(event.target.value)}
                        placeholder="FieldRoutes source ID"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={setupAccess.controlsDisabled}
                        className="h-11 border-white/10 bg-black/40 text-white placeholder:text-white/25 focus-visible:ring-[#39FF4A]/40"
                      />
                      <p className="text-[11px] leading-4 text-white/30">Use the FirstKnock lead source configured in FieldRoutes, if your office has one.</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={setupAccess.controlsDisabled} className="bg-[#39FF4A] font-bold text-black hover:bg-[#2EEB57]">
                      {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                      Save connection
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={setupAccess.explicitlyDisabled || !credentialsSaved || testMutation.isPending}
                      onClick={() => testMutation.mutate()}
                      className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"
                    >
                      {testMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      Test connection
                    </Button>
                  </div>
                </section>

                <section className="space-y-3 border-t border-white/8 pt-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 className="text-sm font-bold">3. Choose the initial inspection service</h2>
                      <p className="mt-1 text-xs text-white/45">Load the company’s visible service types, then choose the initial service the office expects.</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!credentialsSaved || loadServiceTypesMutation.isPending}
                      onClick={() => loadServiceTypesMutation.mutate()}
                      className="shrink-0 border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"
                    >
                      {loadServiceTypesMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                      Load service types
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                    <div className="space-y-2">
                      <Label className="text-xs text-white/65">Service type</Label>
                      <Select value={serviceTypeId || undefined} onValueChange={handleServiceTypeChange} disabled={!credentialsSaved || serviceTypeOptions.length === 0}>
                        <SelectTrigger className="h-11 border-white/10 bg-black/40 text-white focus:ring-[#39FF4A]/40">
                          <SelectValue placeholder="Load service types first" />
                        </SelectTrigger>
                        <SelectContent className="border-white/10 bg-[#111] text-white">
                          {serviceTypeOptions.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}{item.initial ? ' · Initial' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="fieldroutes-duration" className="text-xs text-white/65">Default length</Label>
                      <div className="relative">
                        <Input
                          id="fieldroutes-duration"
                          type="number"
                          min="5"
                          max="480"
                          step="1"
                          value={defaultLength}
                          onChange={(event) => setDefaultLength(event.target.value)}
                          placeholder="60"
                          disabled={!credentialsSaved}
                          className="h-11 border-white/10 bg-black/40 pr-16 text-white placeholder:text-white/25 focus-visible:ring-[#39FF4A]/40"
                        />
                        <span className="pointer-events-none absolute right-3 top-3.5 text-xs text-white/30">minutes</span>
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] leading-5 text-white/35">After choosing the service, save the connection, then test it once more. FirstKnock will create an unassigned inspection; office staff still controls the route, technician, and time.</p>
                </section>

                {credentialsSaved && (
                  <section className="flex flex-col gap-3 border-t border-white/8 pt-6 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white/75">Connected account</p>
                      <p className="mt-1 break-all font-mono text-xs text-white/35">{displayedHost}</p>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" className="border-red-500/25 bg-transparent text-red-200 hover:bg-red-500/10 hover:text-red-100">
                          <Unplug className="mr-2 h-4 w-4" /> Disconnect
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-white/10 bg-[#111] text-white">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Disconnect FieldRoutes?</AlertDialogTitle>
                          <AlertDialogDescription className="text-white/50">
                            Saved credentials will be removed and new inspections will remain in FirstKnock until another connection is configured. Existing FieldRoutes customers and appointments are not deleted.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white">Keep connection</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => disconnectMutation.mutate()}
                            disabled={disconnectMutation.isPending}
                            className="bg-red-500 text-white hover:bg-red-600"
                          >
                            {disconnectMutation.isPending ? 'Disconnecting…' : 'Remove credentials'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </section>
                )}
              </form>
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card className="border-white/10 bg-[#0D0D0D] hover:translate-y-0 hover:border-white/15">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-base">
                  {configReady ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <Clock3 className="h-4 w-4 text-amber-300" />}
                  Rep readiness
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  <ReadinessItem ready={credentialsSaved}>Credentials saved</ReadinessItem>
                  <ReadinessItem ready={connectionVerified}>Connection verified</ReadinessItem>
                  <ReadinessItem ready={Boolean(configuredServiceTypeId)}>Initial service selected</ReadinessItem>
                  <ReadinessItem ready={configReady}>Precision scheduling enabled for reps</ReadinessItem>
                </ul>
                <div className={`mt-5 rounded-xl border p-4 ${configReady ? 'border-emerald-500/20 bg-emerald-500/[0.06]' : 'border-white/10 bg-black/30'}`}>
                  <p className={`text-xs font-bold ${configReady ? 'text-emerald-200' : 'text-white/65'}`}>
                    {configReady ? 'Ready to schedule inspections' : 'Setup is not complete yet'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-white/40">
                    {configReady
                      ? 'Reps can queue an unassigned FieldRoutes inspection from an eligible Precision property.'
                      : 'Save credentials, test, choose and save the service, then test once more.'}
                  </p>
                </div>
                {!canvasEnabled && (
                  <div className="mt-3 rounded-xl border border-purple-300/15 bg-purple-500/[0.05] px-4 py-3 text-xs leading-5 text-purple-100/65">
                    Canvas scheduling stays hidden until the production Canvas territory and address-verification services are enabled. Precision scheduling is independent.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-[#0D0D0D] hover:translate-y-0 hover:border-white/15">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-base"><LockKeyhole className="h-4 w-4 text-sky-300" /> Security</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs leading-5 text-white/45">
                <p>API credentials are write-only and handled by the FirstKnock server.</p>
                <p>FirstKnock never puts credentials in a URL, browser storage, activity row, or provider error message.</p>
                <p>Disconnecting removes the saved connection without deleting records already created in FieldRoutes.</p>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="border-white/10 bg-[#0D0D0D] hover:translate-y-0 hover:border-white/15">
          <CardHeader className="border-b border-white/8 pb-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">Recent FieldRoutes activity</CardTitle>
                <p className="mt-1 text-xs text-white/40">The latest {ACTIVITY_LIMIT} queued and completed inspection requests. Customer contact details are not shown here.</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!configured || activityQuery.isFetching}
                onClick={() => activityQuery.refetch()}
                className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${activityQuery.isFetching ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-0 pt-0">
            {!configured ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <Plug className="h-7 w-7 text-white/20" />
                <p className="text-sm font-semibold text-white/60">Connect FieldRoutes to see sync activity.</p>
              </div>
            ) : activityQuery.isLoading ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-white/40" /></div>
            ) : activityQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <TriangleAlert className="h-6 w-6 text-amber-300" />
                <p className="text-sm text-white/55">{activityQuery.error?.message || 'Recent activity could not be loaded.'}</p>
                <Button size="sm" variant="outline" onClick={() => activityQuery.refetch()} className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white">Try again</Button>
              </div>
            ) : activityRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <CheckCircle2 className="h-7 w-7 text-white/20" />
                <p className="text-sm font-semibold text-white/60">No FieldRoutes requests yet.</p>
                <p className="text-xs text-white/35">Activity appears here after a rep schedules the first inspection.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-white/8 hover:bg-transparent">
                    <TableHead className="px-5 text-[10px] font-bold uppercase tracking-wider text-white/35">Status</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-wider text-white/35">Source</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-wider text-white/35">Location</TableHead>
                    <TableHead className="text-[10px] font-bold uppercase tracking-wider text-white/35">Updated</TableHead>
                    <TableHead className="px-5 text-right text-[10px] font-bold uppercase tracking-wider text-white/35">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activityRows.map((item, index) => {
                    const requestId = normalizeIdentifier(item?.request_id ?? item?.id);
                    const activityState = normalizeStatus(item?.state || item?.status);
                    const status = activityStatus(activityState);
                    const error = activityError(item);
                    const errorCode = normalizeStatus(item?.error_code || item?.last_error_code || item?.code);
                    const retryAllowed = item?.retry_allowed === true
                      && requestId
                      && !PAYLOAD_CORRECTION_REQUIRED_CODES.has(errorCode);
                    const reconciliationRetry = requiresReconciliationConfirmation(item, activityState, errorCode);
                    const retryingThis = retryMutation.isPending && retryMutation.variables?.requestId === requestId;
                    const safeLocation = safeServerLabel(
                      item?.address_safe_label || item?.safe_address_label || item?.source_label,
                      'House location hidden'
                    );
                    return (
                      <TableRow key={requestId || `activity-${index}`} className="border-white/8 hover:bg-white/[0.025]">
                        <TableCell className="px-5 py-4 align-top">
                          <Badge className={status.className}>{status.label}</Badge>
                        </TableCell>
                        <TableCell className="py-4 align-top text-xs text-white/55">{safeSourceMode(item?.source_mode || item?.source_kind || item?.source)}</TableCell>
                        <TableCell className="max-w-[320px] py-4 align-top">
                          <p className="text-xs font-semibold text-white/70">{safeLocation}</p>
                          {error && <p className="mt-1 text-[11px] leading-4 text-amber-200/70">{error}</p>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap py-4 align-top text-xs text-white/40">{formatTimestamp(item?.updated_at || item?.created_at || item?.attempted_at)}</TableCell>
                        <TableCell className="px-5 py-4 text-right align-top">
                          {retryAllowed ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={retryMutation.isPending}
                              onClick={() => {
                                if (!reconciliationRetry) {
                                  retryMutation.mutate({ requestId, reconciliation: false });
                                  return;
                                }
                                const confirmed = window.confirm('Confirm that you reviewed this request in FieldRoutes. FirstKnock will reconcile the existing customer or appointment before attempting any new write. Continue?');
                                if (confirmed) retryMutation.mutate({ requestId, reconciliation: true });
                              }}
                              className="h-8 border-white/15 bg-transparent text-xs text-white hover:bg-white/10 hover:text-white"
                            >
                              {retryingThis ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}
                              {reconciliationRetry ? 'Retry reconciliation' : 'Retry'}
                            </Button>
                          ) : REVIEW_ACTIVITY_STATES.has(activityState) ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-orange-200/55">Review in FieldRoutes</span>
                          ) : (
                            <span className="text-xs text-white/20">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
