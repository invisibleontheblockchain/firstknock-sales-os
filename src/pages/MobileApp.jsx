import React, { useState, useEffect } from 'react';
import { Smartphone, Share, PlusSquare, Menu, ArrowRight, CheckCircle2, Apple, MonitorSmartphone } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";

export default function MobileApp() {
    const [platform, setPlatform] = useState('ios');

    useEffect(() => {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('android')) setPlatform('android');
    }, []);

    return (
        <div className="min-h-screen bg-black text-white p-6 pb-24">
            <div className="max-w-md mx-auto space-y-8">
                
                <div className="text-center space-y-4 pt-8">
                    <div className="w-16 h-16 bg-yellow-500 rounded-2xl mx-auto flex items-center justify-center shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                        <Smartphone className="w-8 h-8 text-black" />
                    </div>
                    <h1 className="text-3xl font-extrabold tracking-tight">Install the App</h1>
                    <p className="text-gray-400">
                        FirstKnock is built as a Progressive Web App (PWA). 
                        Install it directly to your home screen for the full native experience.
                    </p>
                </div>

                <div className="bg-[#111] border border-gray-800 rounded-xl p-4 flex items-start gap-4">
                    <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0 mt-1" />
                    <div className="space-y-1">
                        <h3 className="font-bold text-white">Why install?</h3>
                        <ul className="text-sm text-gray-400 space-y-1 list-disc pl-4">
                            <li>Full screen experience (no browser bars)</li>
                            <li>Works offline in bad service areas</li>
                            <li>One-tap access from home screen</li>
                        </ul>
                    </div>
                </div>

                <Tabs defaultValue="ios" value={platform} onValueChange={setPlatform} className="w-full">
                    <TabsList className="grid w-full grid-cols-2 bg-[#1F1F1F]">
                        <TabsTrigger value="ios" className="data-[state=active]:bg-yellow-500 data-[state=active]:text-black">
                            <Apple className="w-4 h-4 mr-2" /> iPhone (iOS)
                        </TabsTrigger>
                        <TabsTrigger value="android" className="data-[state=active]:bg-yellow-500 data-[state=active]:text-black">
                            <MonitorSmartphone className="w-4 h-4 mr-2" /> Android
                        </TabsTrigger>
                    </TabsList>
                    
                    <TabsContent value="ios" className="mt-6 space-y-4">
                        <Step 
                            num={1} 
                            text="Tap the Share button in Safari's bottom menu bar" 
                            icon={<Share className="w-5 h-5 text-blue-400" />} 
                        />
                        <Step 
                            num={2} 
                            text="Scroll down and tap 'Add to Home Screen'" 
                            icon={<PlusSquare className="w-5 h-5 text-gray-200" />} 
                        />
                        <Step 
                            num={3} 
                            text="Tap 'Add' in the top right corner" 
                            icon={<span className="font-bold text-blue-400">Add</span>} 
                        />
                    </TabsContent>

                    <TabsContent value="android" className="mt-6 space-y-4">
                        <Step 
                            num={1} 
                            text="Tap the three dots menu in Chrome (top right)" 
                            icon={<Menu className="w-5 h-5 text-gray-200" />} 
                        />
                        <Step 
                            num={2} 
                            text="Tap 'Install App' or 'Add to Home screen'" 
                            icon={<MonitorSmartphone className="w-5 h-5 text-gray-200" />} 
                        />
                        <Step 
                            num={3} 
                            text="Confirm by tapping 'Install'" 
                            icon={<CheckCircle2 className="w-5 h-5 text-green-500" />} 
                        />
                    </TabsContent>
                </Tabs>

                <div className="pt-8 text-center">
                    <p className="text-xs text-gray-500 mb-4">
                        Already installed?
                    </p>
                    <Button 
                        onClick={() => window.location.href = '/'}
                        className="bg-gray-800 hover:bg-gray-700 text-white w-full h-12 rounded-xl font-bold"
                    >
                        Open App
                    </Button>
                </div>

            </div>
        </div>
    );
}

function Step({ num, text, icon }) {
    return (
        <Card className="bg-[#111] border-gray-800">
            <CardContent className="flex items-center gap-4 p-4">
                <div className="w-8 h-8 rounded-full bg-yellow-500/10 text-yellow-500 flex items-center justify-center font-bold text-sm shrink-0">
                    {num}
                </div>
                <p className="text-sm text-gray-200 flex-1">{text}</p>
                <div className="w-10 h-10 rounded-lg bg-black border border-gray-800 flex items-center justify-center shrink-0">
                    {icon}
                </div>
            </CardContent>
        </Card>
    );
}