import React, { useState, useEffect } from 'react';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { parseResultText } from './logic/resultParser';
import moment from 'moment';

const STATUS_COLORS = {
    ELIGIBLE: 'bg-green-900 text-green-200',
    QUALIFIED: 'bg-blue-900 text-blue-200',
    CALLBACK: 'bg-yellow-900 text-yellow-200',
    NO_ANSWER: 'bg-slate-700 text-slate-300',
    SOLD: 'bg-red-900 text-red-200',
    HARD_NO: 'bg-red-900 text-red-200',
    OTHER: 'bg-slate-700 text-slate-300'
};

export default function PropertyDrawer({ property, open, onClose, onSubmit }) {
    const [resultText, setResultText] = useState('');
    const [parsed, setParsed] = useState(null);
    
    useEffect(() => {
        if (open) {
            setResultText('');
            setParsed(null);
        }
    }, [open]);
    
    const handleTextChange = (e) => {
        const text = e.target.value;
        setResultText(text);
        setParsed(text.trim() ? parseResultText(text) : null);
    };
    
    const handleSubmit = () => {
        if (!parsed || !property) return;
        
        onSubmit({
            address_hash: property.address_hash,
            date_visited: new Date().toISOString(),
            result_text: resultText,
            parsed_status: parsed.status,
            callback_target: parsed.callbackTarget,
            next_eligible_date: parsed.nextDate,
            gps_lat: property.lat,
            gps_lng: property.lng
        });
        
        onClose();
    };
    
    if (!property) return null;
    
    return (
        <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
            <DrawerContent className="bg-slate-900 border-t-slate-700 text-slate-100">
                <div className="mx-auto w-full max-w-sm">
                    <DrawerHeader>
                        <DrawerTitle className="text-xl">{property.full_address}</DrawerTitle>
                        <DrawerDescription className="text-slate-400 flex items-center gap-2">
                            Status: 
                            <Badge className={STATUS_COLORS[property.effective_status]}>
                                {property.effective_status}
                            </Badge>
                        </DrawerDescription>
                    </DrawerHeader>
                    
                    <div className="p-4 space-y-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">Log Result</label>
                            <Input 
                                placeholder="e.g., 'not home', 'sold', 'call back March'..."
                                value={resultText}
                                onChange={handleTextChange}
                                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                                autoFocus
                            />
                        </div>
                        
                        {parsed && (
                            <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-slate-400 uppercase">Detected</span>
                                    <Badge className={STATUS_COLORS[parsed.status]}>{parsed.status}</Badge>
                                </div>
                                {parsed.nextDate && (
                                    <div className="text-xs text-slate-400">
                                        Next eligible: {moment(parsed.nextDate).format('MMM D, YYYY')}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    
                    <DrawerFooter>
                        <Button 
                            onClick={handleSubmit} 
                            disabled={!parsed}
                            className="w-full bg-indigo-600 hover:bg-indigo-700"
                        >
                            Save Result
                        </Button>
                        <DrawerClose asChild>
                            <Button variant="outline" className="w-full border-slate-700 text-slate-300 hover:bg-slate-800">
                                Cancel
                            </Button>
                        </DrawerClose>
                    </DrawerFooter>
                </div>
            </DrawerContent>
        </Drawer>
    );
}