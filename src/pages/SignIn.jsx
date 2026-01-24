import React, { useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2 } from 'lucide-react';

export default function SignIn() {
    useEffect(() => {
        base44.auth.redirectToLogin(window.location.origin);
    }, []);

    return (
        <div className="flex h-screen items-center justify-center bg-[#0A0A0A] text-white">
            <Loader2 className="w-10 h-10 animate-spin text-yellow-500" />
        </div>
    );
}