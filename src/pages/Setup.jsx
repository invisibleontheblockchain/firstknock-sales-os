import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Upload, MapPin, CheckCircle2 } from 'lucide-react';
import CsvUploader from '../components/dashboard/CsvUploader';
import { createPageUrl } from '@/utils';

export default function Setup() {
    const navigate = useNavigate();
    const [step, setStep] = useState(1);
    const [zipCodes, setZipCodes] = useState('');

    const handleContinue = () => {
        navigate(createPageUrl('Home'));
    };

    return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
            <div className="max-w-2xl w-full bg-[#111] p-8 rounded-3xl border border-[#222] shadow-2xl">
                <div className="text-center space-y-4 mb-10">
                    <div className="flex justify-center">
                        <div className="w-16 h-16 bg-yellow-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(255,215,0,0.3)]">
                            <Upload className="w-8 h-8 text-black" />
                        </div>
                    </div>
                    <h1 className="text-4xl font-bold tracking-tighter text-white">Data Center</h1>
                    <p className="text-gray-400 max-w-sm mx-auto">
                        Your property data is securely stored. You only need to upload new data when you want to update or expand your territory.
                    </p>
                </div>

                <div className="space-y-6">
                    <div className="p-6 rounded-2xl bg-[#0A0A0A] border border-[#222]">
                        <h3 className="text-lg font-bold text-white mb-2">Upload New List</h3>
                        <p className="text-sm text-gray-500 mb-6">Supported formats: CSV, JSON. Automatically merges with existing records.</p>
                        <CsvUploader />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#222]">
                            <h4 className="text-white font-bold">Safe & Secure</h4>
                            <p className="text-xs text-gray-500 mt-1">Data persists across sessions</p>
                        </div>
                        <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#222]">
                            <h4 className="text-white font-bold">Auto-Merge</h4>
                            <p className="text-xs text-gray-500 mt-1">Updates existing records</p>
                        </div>
                    </div>

                    <Button 
                        onClick={handleContinue}
                        className="w-full h-14 text-lg bg-yellow-500 text-black font-bold hover:bg-yellow-400 rounded-xl mt-4"
                    >
                        GO TO MAP
                    </Button>
                </div>
            </div>
        </div>
    );
}