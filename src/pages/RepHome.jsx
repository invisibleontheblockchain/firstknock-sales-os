import React from 'react';
import { Button } from "@/components/ui/button";

export default function RepHome() {
    return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-black text-white p-6 text-center">
            <h1 className="text-3xl font-bold text-yellow-500 mb-4">Rep Home Debug</h1>
            <p className="mb-6">If you can see this, the page is loading correctly.</p>
            <Button 
                onClick={() => window.location.reload()}
                className="bg-gray-800 text-white"
            >
                Refresh
            </Button>
        </div>
    );
}