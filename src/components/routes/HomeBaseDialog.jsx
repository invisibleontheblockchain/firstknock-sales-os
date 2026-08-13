import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Home, Loader2, Locate } from 'lucide-react';
import { geocodeAddress } from '@/lib/geocoding';

/**
 * Home Base — the rep's own start/finish point for "Optimize from Home".
 *
 * It is asked for at the moment it is needed (choosing HOME on a route that has
 * no Home Base yet) and is also editable from Map Settings, so the optimizer
 * never dead-ends on a missing personal location.
 */
export default function HomeBaseDialog({ homeBase = null, onClose, onSave, title = 'Home Base' }) {
    const [address, setAddress] = useState(homeBase?.address || '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const save = async (point) => {
        setBusy(true);
        setError('');
        try {
            await onSave(point);
            onClose();
        } catch (e) {
            setError(e?.message || 'Could not save your Home Base.');
        } finally {
            setBusy(false);
        }
    };

    const submitAddress = async () => {
        setBusy(true);
        setError('');
        try {
            const point = await geocodeAddress(address.trim());
            await onSave(point);
            onClose();
        } catch (e) {
            setError(e?.message || 'Could not save your Home Base.');
        } finally {
            setBusy(false);
        }
    };

    const useCurrentLocation = () => {
        if (!navigator.geolocation) {
            setError('This device cannot share its location. Enter an address instead.');
            return;
        }
        setBusy(true);
        setError('');
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setBusy(false);
                save({
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    address: 'My current location'
                });
            },
            () => {
                setBusy(false);
                setError('Location unavailable. Enter your address instead.');
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
        );
    };

    return (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
            <DialogContent className="z-[5000] max-w-md border-white/10 bg-[#0A0A0A] text-white">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-base font-black">
                        <Home className="h-4 w-4 text-[#39FF4A]" /> {title}
                    </DialogTitle>
                    <DialogDescription className="text-xs text-white/50">
                        Routes optimized from home start at the door closest to this address and finish at the
                        closest door on the way back. Only you see it.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <Input
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !busy) submitAddress(); }}
                        placeholder="123 Main St, Anderson, SC 29621"
                        autoFocus
                        className="border-white/15 bg-black/60 text-sm text-white placeholder:text-white/30"
                    />

                    {error && (
                        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-300">{error}</p>
                    )}

                    <div className="flex items-center gap-2">
                        <Button
                            onClick={submitAddress}
                            disabled={busy || !address.trim()}
                            className="h-10 flex-1 rounded-xl bg-[#2EEB57] text-[11px] font-black text-black hover:bg-[#39FF4A]"
                        >
                            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Home className="mr-1.5 h-4 w-4" />}
                            SAVE HOME BASE
                        </Button>
                        <Button
                            onClick={useCurrentLocation}
                            disabled={busy}
                            variant="ghost"
                            className="h-10 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black text-white/70 hover:bg-white/10 hover:text-white"
                            title="Use my current location"
                        >
                            <Locate className="mr-1.5 h-3.5 w-3.5" /> USE GPS
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}