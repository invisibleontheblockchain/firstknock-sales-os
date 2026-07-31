import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createLeadFromAddress } from './internalSearchClient';

/**
 * Manual lead entry for an address that is not in FirstKnock yet.
 * The record is only created when this form is submitted — the temporary
 * search marker never writes to the database on its own.
 */
export default function AddLeadFromAddressDialog({ addressResult, onCancel, onCreated }) {
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (saving || !addressResult) return;
    setSaving(true);
    setError('');
    try {
      const response = await createLeadFromAddress({
        address: addressResult.street || addressResult.formatted_address,
        city: addressResult.city,
        state: addressResult.state,
        zip: addressResult.zip,
        lat: addressResult.lat,
        lng: addressResult.lng,
        owner_full_name: ownerName,
        owner_phone: phone,
        notes,
      });
      if (response?.error) throw new Error(response.message || response.error);
      if (!response?.property) throw new Error('The lead could not be saved. Please try again.');
      onCreated?.(response.property, { duplicate: response.duplicate === true });
    } catch (saveError) {
      setError(saveError?.response?.data?.message || saveError?.message || 'The lead could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!addressResult} onOpenChange={(open) => { if (!open && !saving) onCancel?.(); }}>
      <DialogContent className="z-[3000] max-w-md border-white/10 bg-[#050505] text-white">
        <DialogHeader>
          <DialogTitle>Add as Lead</DialogTitle>
          <DialogDescription className="text-white/55">
            {addressResult?.formatted_address}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="lead-owner-name" className="text-[10px] font-black uppercase tracking-[0.14em] text-white/50">Customer name</Label>
            <Input id="lead-owner-name" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="Amanda Whitfield" className="border-white/10 bg-black/50 text-white" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-phone" className="text-[10px] font-black uppercase tracking-[0.14em] text-white/50">Phone</Label>
            <Input id="lead-phone" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="Optional" className="border-white/10 bg-black/50 text-white" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-notes" className="text-[10px] font-black uppercase tracking-[0.14em] text-white/50">Notes</Label>
            <Input id="lead-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Called in about a quote" className="border-white/10 bg-black/50 text-white" />
          </div>
          {error && <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200" aria-live="polite">{error}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onCancel?.()}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : 'Save Lead'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}