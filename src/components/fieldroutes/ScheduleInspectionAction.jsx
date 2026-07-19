import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarPlus, CheckCircle2, Loader2, X } from 'lucide-react';
import {
  fieldRoutesAppointmentId,
  isFieldRoutesCapabilityReady,
  fieldRoutesStatusPresentation,
  splitContactName,
} from './fieldRoutesPresentation';

const INPUT_CLASS = 'w-full rounded-xl border border-white/10 bg-black/70 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#2EEB57]';

function initialForm(initialValues) {
  const parsedName = splitContactName(initialValues?.customerName || initialValues?.ownerName);
  return {
    firstName: String(initialValues?.firstName || parsedName.firstName || ''),
    lastName: String(initialValues?.lastName || parsedName.lastName || ''),
    phone: String(initialValues?.phone || ''),
    email: String(initialValues?.email || ''),
    notes: String(initialValues?.notes || ''),
    streetAddress: String(initialValues?.streetAddress || initialValues?.address || ''),
    unit: String(initialValues?.unit || ''),
    city: String(initialValues?.city || ''),
    state: String(initialValues?.state || ''),
    zip: String(initialValues?.zip || initialValues?.zipCode || ''),
  };
}

function statusTone(tone) {
  if (tone === 'synced') return 'border-emerald-300/25 bg-emerald-500/10 text-emerald-100';
  if (tone === 'attention') return 'border-red-300/25 bg-red-500/10 text-red-100';
  if (tone === 'device') return 'border-amber-300/25 bg-amber-500/10 text-amber-100';
  return 'border-blue-300/25 bg-blue-500/10 text-blue-100';
}

export function FieldRoutesStatusChip({ status }) {
  if (!status) return null;
  const presentation = fieldRoutesStatusPresentation(status);
  const appointmentId = fieldRoutesAppointmentId(status);
  return (
    <div className={`rounded-xl border px-3 py-2 text-[10px] font-bold leading-relaxed ${statusTone(presentation.tone)}`}>
      <span>{presentation.label}</span>
      {appointmentId && <span className="mt-1 block font-mono text-[9px] opacity-75">Appointment #{appointmentId}</span>}
    </div>
  );
}

export default function ScheduleInspectionAction({
  capability,
  mode = 'precision',
  initialValues,
  status,
  disabled = false,
  disabledReason = '',
  pendingDeviceCount = 0,
  onDiscardDeviceAttention,
  onSubmit,
}) {
  const ready = isFieldRoutesCapabilityReady(capability);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => initialForm(initialValues));
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionError, setActionError] = useState('');
  const dialogRef = useRef(null);
  const firstNameRef = useRef(null);
  const canvas = mode === 'canvas';
  const existingStatus = status ? fieldRoutesStatusPresentation(status) : null;

  const formIdentity = useMemo(() => JSON.stringify(initialValues || {}), [initialValues]);
  useEffect(() => {
    if (!open) setForm(initialForm(initialValues));
    // formIdentity is the stable dependency for callers that construct their
    // prefill object inline. Depending on the object itself causes a reset loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formIdentity, open]);

  useEffect(() => {
    if (!open) return undefined;
    const priorFocus = document.activeElement;
    const frame = window.requestAnimationFrame(() => firstNameRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      priorFocus?.focus?.();
    };
  }, [open]);

  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError('');
  };

  const discardDeviceAttention = async () => {
    if (status?.local_only !== true || status?.kind !== 'device_attention' || typeof onDiscardDeviceAttention !== 'function') return;
    const confirmed = window.confirm('Discard this unsent device copy so you can correct it? It is not visible to the office and cannot be recovered.');
    if (!confirmed) return;
    setDiscarding(true);
    setActionError('');
    try {
      await onDiscardDeviceAttention();
    } catch (discardError) {
      setActionError(discardError?.message || 'This device copy could not be discarded.');
    } finally {
      setDiscarding(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) return setError('Confirm the customer’s first and last name.');
    if (!form.phone.trim() && !form.email.trim()) return setError('Add at least a phone number or email address.');
    const phoneDigits = form.phone.replace(/\D/g, '');
    const phoneFormatValid = /^\+?[\d\s().-]+$/.test(form.phone.trim());
    if (form.phone.trim() && (!phoneFormatValid || !(phoneDigits.length === 10 || phoneDigits.length === 11 && phoneDigits.startsWith('1')))) {
      return setError('Enter a valid 10-digit US phone number, with an optional +1 country code.');
    }
    if (canvas && (!form.streetAddress.trim() || !form.city.trim() || !form.state.trim() || !form.zip.trim())) {
      return setError('Canvas inspections require street address, city, state, and ZIP.');
    }
    if (canvas && !/^[A-Za-z]{2}$/.test(form.state.trim())) {
      return setError('Enter a two-letter state abbreviation.');
    }
    if (canvas && !/^\d{5}(?:-\d{4})?$/.test(form.zip.trim())) {
      return setError('Enter a valid 5-digit ZIP code, with an optional 4-digit extension.');
    }
    setSubmitting(true);
    setError('');
    try {
      await onSubmit?.({
        contact: {
          first_name: form.firstName.trim(),
          last_name: form.lastName.trim(),
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
        },
        property: {
          street_address: form.streetAddress.trim(),
          unit: form.unit.trim() || null,
          city: form.city.trim(),
          state: form.state.trim().toUpperCase(),
          zip: form.zip.trim(),
        },
        notes: form.notes.trim() || null,
      });
      setOpen(false);
    } catch (submitError) {
      setError(submitError?.message || 'Inspection could not be saved. Review the details and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      {existingStatus ? (
        <div className={`min-h-12 w-full rounded-2xl border px-4 py-3 text-center text-xs font-black ${statusTone(existingStatus.tone)}`}>
          <div className="flex items-center justify-center gap-2">
            {existingStatus.tone === 'synced' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            {existingStatus.tone === 'attention'
              ? 'Inspection needs manager review'
              : existingStatus.tone === 'synced'
                ? 'Inspection already sent'
                : existingStatus.tone === 'superseded'
                  ? 'Inspection request replaced'
                  : 'Inspection request already pending'}
          </div>
          {fieldRoutesAppointmentId(status) && <span className="mt-1 block font-mono text-[9px] opacity-75">Appointment #{fieldRoutesAppointmentId(status)}</span>}
          {status?.local_only === true && status?.kind === 'device_attention' && typeof onDiscardDeviceAttention === 'function' && (
            <button
              type="button"
              disabled={discarding}
              onClick={discardDeviceAttention}
              className="mt-2 min-h-9 w-full rounded-xl border border-current/25 bg-black/20 px-3 py-2 text-[10px] font-black disabled:opacity-50"
            >
              {discarding ? 'Discarding device copy…' : 'Discard device copy and correct'}
            </button>
          )}
        </div>
      ) : ready ? (
        <>
          <button
            type="button"
            disabled={disabled || submitting}
            onClick={() => { setError(''); setOpen(true); }}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-emerald-300/35 bg-gradient-to-r from-[#2EEB57] to-[#B6FF5C] px-4 py-3 text-sm font-black text-black shadow-[0_12px_35px_rgba(46,235,87,0.18)] transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CalendarPlus className="h-4 w-4" /> Schedule Inspection
          </button>
          {disabled && disabledReason && <p className="text-[10px] leading-relaxed text-amber-100/75">{disabledReason}</p>}
        </>
      ) : (
        <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] leading-relaxed text-white/50">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" />
          FieldRoutes scheduling appears after your manager finishes the integration setup.
        </div>
      )}
      {actionError && <p role="alert" className="rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs text-red-100">{actionError}</p>}
      {pendingDeviceCount > 0 && (
        <p className="text-[10px] font-bold text-amber-200">{pendingDeviceCount} inspection{pendingDeviceCount === 1 ? '' : 's'} retained on this device for this signed-in team.</p>
      )}

      {open && (
        <div className="fixed inset-0 z-[5000] flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center" onClick={() => !submitting && setOpen(false)}>
          <form
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="fieldroutes-schedule-title"
            onKeyDown={handleDialogKeyDown}
            onSubmit={submit}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-white/10 bg-[#08090b] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-white shadow-2xl sm:rounded-3xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p id="fieldroutes-schedule-title" className="text-base font-black">Schedule Inspection</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/50">Creates an unassigned FieldRoutes inspection for the office to schedule.</p>
              </div>
              <button type="button" aria-label="Close Schedule Inspection" disabled={submitting} onClick={() => setOpen(false)} className="rounded-full bg-white/10 p-2 text-white"><X className="h-4 w-4" /></button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <input ref={firstNameRef} aria-label="Customer first name" value={form.firstName} onChange={(event) => update('firstName', event.target.value)} placeholder="First name" autoComplete="given-name" maxLength={100} className={INPUT_CLASS} />
              <input aria-label="Customer last name" value={form.lastName} onChange={(event) => update('lastName', event.target.value)} placeholder="Last name" autoComplete="family-name" maxLength={100} className={INPUT_CLASS} />
              <input aria-label="Customer phone number" value={form.phone} onChange={(event) => update('phone', event.target.value)} placeholder="Phone" type="tel" autoComplete="tel" maxLength={40} className={INPUT_CLASS} />
              <input aria-label="Customer email address" value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="Email" type="email" autoComplete="email" maxLength={254} className={INPUT_CLASS} />
            </div>

            {canvas ? (
              <div className="mt-3 space-y-2 rounded-2xl border border-purple-300/20 bg-purple-500/[0.06] p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-purple-100">Confirm this Canvas house</p>
                <p className="text-[10px] leading-relaxed text-purple-100/60">The synced pin confirms territory ownership, not the postal address. Verify every field with the resident before sending it to FieldRoutes.</p>
                <input aria-label="House street address" value={form.streetAddress} onChange={(event) => update('streetAddress', event.target.value)} placeholder="Street address" autoComplete="street-address" maxLength={300} className={INPUT_CLASS} />
                <input aria-label="House unit or apartment" value={form.unit} onChange={(event) => update('unit', event.target.value)} placeholder="Unit / apartment (optional)" maxLength={100} className={INPUT_CLASS} />
                <div className="grid grid-cols-[1fr_72px_96px] gap-2">
                  <input aria-label="House city" value={form.city} onChange={(event) => update('city', event.target.value)} placeholder="City" maxLength={100} className={INPUT_CLASS} />
                  <input aria-label="House state" value={form.state} onChange={(event) => update('state', event.target.value)} placeholder="State" maxLength={2} className={INPUT_CLASS} />
                  <input aria-label="House ZIP code" value={form.zip} onChange={(event) => update('zip', event.target.value)} placeholder="ZIP" inputMode="numeric" maxLength={10} className={INPUT_CLASS} />
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/65">
                {form.streetAddress || 'The backend will verify this route property address.'}{form.unit ? `, ${form.unit}` : ''}
                {(form.city || form.state || form.zip) && <span className="block text-[10px] text-white/40">{[form.city, form.state, form.zip].filter(Boolean).join(', ')}</span>}
              </div>
            )}

            <textarea aria-label="Notes for the office" value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Notes for the office (optional)" maxLength={1000} className={`${INPUT_CLASS} mt-3 min-h-20 resize-none`} />
            {error && <p role="alert" className="mt-3 rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs text-red-100">{error}</p>}
            <button type="submit" disabled={submitting} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2EEB57] text-sm font-black text-black disabled:opacity-50">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {submitting ? 'Saving inspection…' : 'Send unassigned inspection'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
