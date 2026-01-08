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
            <div className="max-w-xl w-full space-y-8">
                <div className="text-center space-y-2">
                    <div className="flex justify-center mb-4">
                        <svg width="64" height="64" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M256 100 L400 120 V400 L256 420 V100 Z" fill="#FFD700" stroke="none"/>
                            <rect x="150" y="80" width="220" height="360" rx="4" stroke="#333333" strokeWidth="12" fill="none"/>
                            <path d="M160 90 L256 100 V410 L160 420 V90 Z" fill="#0A0A0A" stroke="#1F1F1F" strokeWidth="2"/>
                            <rect x="235" y="240" width="8" height="24" rx="2" fill="#FFD700"/>
                        </svg>
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight">Setup Territory</h1>
                    <p className="text-gray-400">Initialize your sales map with target data.</p>
                </div>

                <div className="grid gap-6">
                    {/* Step 1: Upload */}
                    <Card className={`bg-gray-900 border-gray-800 transition-all ${step === 1 ? 'ring-2 ring-yellow-500' : 'opacity-50'}`}>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-3 text-white">
                                <div className="w-8 h-8 rounded-full bg-yellow-500 text-black flex items-center justify-center font-bold">1</div>
                                Upload Property Data
                            </CardTitle>
                            <CardDescription>
                                Upload your JSON or CSV file containing property addresses and sales data.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between bg-black/50 p-4 rounded-lg border border-gray-800">
                                <CsvUploader />
                                <div className="text-xs text-gray-500">
                                    Supports .json, .csv
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Step 2: Target Zips (Visual only for now as requested flow) */}
                    <Card className={`bg-gray-900 border-gray-800 transition-all ${step === 2 ? 'ring-2 ring-yellow-500' : ''}`}>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-3 text-white">
                                <div className="w-8 h-8 rounded-full bg-gray-700 text-white flex items-center justify-center font-bold">2</div>
                                Target Areas
                            </CardTitle>
                            <CardDescription>
                                Verify zip codes found in your upload.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-4">
                                <p className="text-sm text-gray-400">
                                    Ready to explore your territory?
                                </p>
                                <Button 
                                    onClick={handleContinue}
                                    className="w-full bg-yellow-500 text-black font-bold hover:bg-yellow-400"
                                >
                                    GO TO MAP
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}