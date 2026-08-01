import React from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Key } from 'lucide-react';

export default function CreateTeamDialog({ open, onOpenChange, teamName, onTeamNameChange, onCreate, isPending }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>
                <Button
                    size="sm"
                    className="h-7 md:h-8 flex-1 md:flex-none bg-gray-800 text-gray-300 font-bold hover:bg-gray-700 hover:text-white border border-gray-700 text-[10px] md:text-xs"
                >
                    <Key className="w-3.5 h-3.5 mr-1.5" /> Create Team
                </Button>
            </DialogTrigger>
            <DialogContent className="bg-[#111] border-gray-800 text-white sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Name Your Team</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-2">
                    <p className="text-sm text-gray-400">Enter the team name reps will see when they join.</p>
                    <Input
                        value={teamName}
                        onChange={(e) => onTeamNameChange(e.target.value)}
                        placeholder="e.g. Charleston Sales Team"
                        className="bg-black border-gray-700 text-white"
                    />
                    <Button onClick={onCreate} disabled={!teamName.trim() || isPending} className="w-full bg-yellow-500 text-black hover:bg-yellow-400 font-black">
                        {isPending ? 'Creating...' : 'Create Team'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}