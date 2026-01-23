import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MapPin, X, Plus, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from "@tanstack/react-query";

export default function TerritoryFilter({ user, properties }) {
    const queryClient = useQueryClient();
    const [zipInput, setZipInput] = useState('');
    const [selectedZips, setSelectedZips] = useState(user?.territory_zip_codes || []);
    const [territoryName, setTerritoryName] = useState(user?.territory_name || '');

    // Get unique zip codes from properties
    const availableZips = useMemo(() => {
        const zips = new Map();
        properties.forEach(p => {
            if (p.zip_code) {
                const zip = String(p.zip_code).trim().slice(0, 5);
                if (zip && /^\d{5}$/.test(zip)) {
                    zips.set(zip, (zips.get(zip) || 0) + 1);
                }
            }
        });
        return Array.from(zips.entries())
            .map(([zip, count]) => ({ zip, count }))
            .sort((a, b) => b.count - a.count);
    }, [properties]);

    // Filter suggestions based on input
    const suggestions = useMemo(() => {
        if (!zipInput) return availableZips.slice(0, 10);
        return availableZips
            .filter(z => z.zip.startsWith(zipInput) && !selectedZips.includes(z.zip))
            .slice(0, 10);
    }, [zipInput, availableZips, selectedZips]);

    // Count properties in selected territory
    const territoryCount = useMemo(() => {
        if (selectedZips.length === 0) return properties.length;
        return properties.filter(p => {
            const zip = String(p.zip_code || '').trim().slice(0, 5);
            return selectedZips.includes(zip);
        }).length;
    }, [properties, selectedZips]);

    const saveMutation = useMutation({
        mutationFn: async () => {
            await base44.auth.updateMe({
                territory_zip_codes: selectedZips,
                territory_name: territoryName
            });
        },
        onSuccess: () => {
            queryClient.invalidateQueries(['user']);
        }
    });

    const addZip = (zip) => {
        if (zip && /^\d{5}$/.test(zip) && !selectedZips.includes(zip)) {
            setSelectedZips([...selectedZips, zip]);
            setZipInput('');
        }
    };

    const removeZip = (zip) => {
        setSelectedZips(selectedZips.filter(z => z !== zip));
    };

    const handleSave = () => {
        saveMutation.mutate();
    };

    const hasChanges = 
        JSON.stringify(selectedZips) !== JSON.stringify(user?.territory_zip_codes || []) ||
        territoryName !== (user?.territory_name || '');

    return (
        <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#222] space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-yellow-500" />
                    Territory Filter
                </h3>
                <Badge variant="outline" className="text-yellow-500 border-yellow-500/30">
                    {territoryCount.toLocaleString()} properties
                </Badge>
            </div>

            <p className="text-xs text-gray-500">
                Select zip codes to filter your territory. Only these properties will show on the map.
            </p>

            {/* Territory Name */}
            <Input
                placeholder="Territory name (e.g., 'North Phoenix')"
                value={territoryName}
                onChange={(e) => setTerritoryName(e.target.value)}
                className="bg-[#1a1a1a] border-[#333] text-white text-sm"
            />

            {/* Selected Zips */}
            {selectedZips.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {selectedZips.map(zip => (
                        <Badge 
                            key={zip} 
                            className="bg-yellow-500/20 text-yellow-500 border border-yellow-500/30 px-2 py-1 flex items-center gap-1"
                        >
                            {zip}
                            <button onClick={() => removeZip(zip)} className="ml-1 hover:text-yellow-300">
                                <X className="w-3 h-3" />
                            </button>
                        </Badge>
                    ))}
                    <button 
                        onClick={() => setSelectedZips([])}
                        className="text-xs text-gray-500 hover:text-red-400"
                    >
                        Clear all
                    </button>
                </div>
            )}

            {/* Zip Input */}
            <div className="flex gap-2">
                <Input
                    placeholder="Enter zip code..."
                    value={zipInput}
                    onChange={(e) => setZipInput(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    onKeyDown={(e) => e.key === 'Enter' && addZip(zipInput)}
                    className="bg-[#1a1a1a] border-[#333] text-white text-sm flex-1"
                />
                <Button 
                    onClick={() => addZip(zipInput)}
                    size="icon"
                    disabled={!zipInput || zipInput.length !== 5}
                    className="bg-[#222] hover:bg-[#333]"
                >
                    <Plus className="w-4 h-4" />
                </Button>
            </div>

            {/* Suggestions from data */}
            {suggestions.length > 0 && (
                <div className="space-y-2">
                    <p className="text-xs text-gray-500">Available in your data:</p>
                    <div className="flex flex-wrap gap-2">
                        {suggestions.map(({ zip, count }) => (
                            <button
                                key={zip}
                                onClick={() => addZip(zip)}
                                disabled={selectedZips.includes(zip)}
                                className={`px-2 py-1 rounded text-xs transition-colors ${
                                    selectedZips.includes(zip) 
                                        ? 'bg-yellow-500/20 text-yellow-500' 
                                        : 'bg-[#1a1a1a] text-gray-400 hover:bg-[#222] hover:text-white'
                                }`}
                            >
                                {zip} ({count})
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Save Button */}
            {hasChanges && (
                <Button 
                    onClick={handleSave}
                    disabled={saveMutation.isPending}
                    className="w-full bg-yellow-500 text-black font-bold hover:bg-yellow-400"
                >
                    {saveMutation.isPending ? 'Saving...' : (
                        <>
                            <Check className="w-4 h-4 mr-2" />
                            Save Territory ({selectedZips.length === 0 ? 'All Zips' : selectedZips.length + ' zips'})
                        </>
                    )}
                </Button>
            )}

            {saveMutation.isSuccess && !hasChanges && (
                <p className="text-xs text-green-500 text-center">✓ Territory saved</p>
            )}
        </div>
    );
}