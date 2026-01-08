import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function UserNotRegisteredError() {
    return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
            <div className="text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                <h1 className="text-xl font-bold text-white mb-2">Access Denied</h1>
                <p className="text-slate-400">You are not registered to use this app.</p>
            </div>
        </div>
    );
}