import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Flag, Loader2, MapPin, Trash2 } from 'lucide-react';
import { geocodeAddress } from '@/lib/geocoding';

/**
 * ANCHORS — set the fixed start and finish of one soloed route.
 *
 * Addresses are resolved to coordinates here so the route stores a real point,
 * and the copy states plainly that the anchor is shared with the assigned rep:
 * these are crew locations (office, trailer, meeting spot), not personal ones.
 */
export default function RouteAnchorsDialog({ route, onClose, onApply }) {
    const [startAddress, setStartAddress] = useState(route?.start_location?.address || '');
    const [endAddress, setEndAddress] = useState(route?.end_location?.address || '');
    const [sameAsStart, setSameAsStart] = useState(
        Boolean(route?.start_location?.address) && route?.start_location?.address === route?.end_location?.address
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const submit = async () => {
        const start = startAddress.trim();
        const end = sameAsStart ? start : endAddress.trim();
        if (!start && !end) {
            setError('Enter a start address, a finish address, or both.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const startPoint = start ? await geocodeAddress(start) : null;
            const endPoint = sameAsStart ? startPoint : (end ? await geocodeAddress(end) : null);
            await onApply({ start: startPoint, end: endPoint });
            onClose();
        } catch (e) {
            setError(e?.message || 'Could not set the route anchors.');
        } finally {
            setBusy(false);
        }
    };

    const clearAnchors = async () => {
        setBusy(true);
        setError('');
        try {
            await onApply(null);
            onClose();
        } catch (e) {
            setError(e?.message || 'Could not clear the route anchors.');
        } finally {
            setBusy(false);
        }
    };

    const hasAnchors = Boolean(route?.start_location || route?.end_location);

    return (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
            <DialogContent className="z-[5000] max-w-md border-white/10 bg-[#0A0A0A] text-white">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-base font-black">
                        <Flag className="h-4 w-4 text-[#39FF4A]" /> Route Anchors
                    </DialogTitle>
                    <DialogDescription className="text-xs text-white/50">
                        Set where this route starts and finishes, then the door order is rebuilt around it.
                        Use a shared crew location — the assigned rep sees this address.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label className="text-[10px] font-black uppercase tracking-[0.18em] text-white/60">Start</Label>
                        <Input
                            value={startAddress}
                            onChange={(e) => setStartAddress(e.target.value)}
                            placeholder="123 Main St, Anderson, SC 29621"
                            className="border-white/15 bg-black/60 text-sm text-white placeholder:text-white/30"
                        />
                    </div>

                    <label className="flex items-center gap-2 text-[11px] font-bold text-white/70">
                        <input
                            type="checkbox"
                            checked={sameAsStart}
                            onChange={(e) => setSameAsStart(e.target.checked)}
                            className="h-3.5 w-3.5 accent-[#2EEB57]"
                        />
                        Finish back at the start (round trip)
                    </label>

                    {!sameAsStart && (
                        <div className="space-y-1.5">
                            <Label className="text-[10px] font-black uppercase tracking-[0.18em] text-white/60">Finish</Label>
                            <Input
                                value={endAddress}
                                onChange={(e) => setEndAddress(e.target.value)}
                                placeholder="456 Oak Ave, Anderson, SC 29621"
                                className="border-white/15 bg-black/60 text-sm text-white placeholder:text-white/30"
                            />
                        </div>
                    )}

                    {error && (
                        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-300">{error}</p>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                        <Button
                            onClick={submit}
                            disabled={busy}
                            className="h-10 flex-1 rounded-xl bg-[#2EEB57] text-[11px] font-black text-black hover:bg-[#39FF4A]"
                        >
                            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <MapPin className="mr-1.5 h-4 w-4" />}
                            SET ANCHORS
                        </Button>
                        {hasAnchors && (
                            <Button
                                onClick={clearAnchors}
                                disabled={busy}
                                variant="ghost"
                                className="h-10 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black text-white/70 hover:bg-white/10 hover:text-white"
                                title="Remove the fixed start and finish"
                            >
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> CLEAR
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}