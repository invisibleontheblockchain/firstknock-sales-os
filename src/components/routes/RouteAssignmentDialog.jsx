import React, { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function RouteAssignmentDialog({ assignment, onCancel, onConfirm }) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const confirm = async () => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            await onConfirm(assignment);
            onCancel();
        } catch (failure) {
            setError(failure.response?.data?.error || failure.message || 'Could not save this assignment. Try again.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={!!assignment} onOpenChange={open => { if (!open && !saving) onCancel(); }}>
            <DialogContent overlayClassName="z-[4999]" className="z-[5000] w-[calc(100%-2rem)] rounded-lg border-gray-700 bg-[#111] text-white sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Confirm route assignment</DialogTitle>
                    <DialogDescription className="break-words text-gray-400">
                        {assignment?.memberId
                            ? <>Assign <strong className="text-white">{assignment.routeName}</strong> to <strong className="text-white">{assignment.memberName}</strong>?</>
                            : <>Remove the assignment from <strong className="text-white">{assignment?.routeName}</strong>?</>}
                    </DialogDescription>
                </DialogHeader>
                {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
                <DialogFooter className="gap-2">
                    <Button variant="outline" disabled={saving} onClick={onCancel} className="border-gray-700 bg-transparent">Cancel</Button>
                    <Button disabled={saving} onClick={confirm} className="bg-yellow-500 text-black hover:bg-yellow-400">
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                        {saving ? 'Saving...' : 'Confirm assignment'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
