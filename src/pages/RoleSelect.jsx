import React from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigation, Users, Briefcase, ChevronRight } from 'lucide-react';
import { Button } from "@/components/ui/button";

export default function RoleSelect() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    const updateUserMutation = useMutation({
        mutationFn: (data) => base44.auth.updateMe(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user'] })
    });

    const selectRole = async (role) => {
        await updateUserMutation.mutateAsync({ app_role: role });
        if (role === 'manager') {
            navigate(createPageUrl('Home'));
        } else {
            navigate(createPageUrl('RepHome'));
        }
    };

    // No auto-redirect so users can switch roles if they land here

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
            <div className="w-16 h-16 bg-yellow-500 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                <Navigation className="w-8 h-8 text-black" />
            </div>
            
            <h1 className="text-2xl font-bold text-white mb-2">Welcome to FirstKnock</h1>
            <p className="text-gray-400 text-center mb-8 max-w-xs">
                Select your role to get the right experience
            </p>

            <div className="w-full max-w-sm space-y-4">
                <button
                    onClick={() => selectRole('rep')}
                    className="w-full p-5 rounded-xl border-2 border-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20 transition-all text-left group"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-yellow-500 rounded-xl flex items-center justify-center">
                            <Briefcase className="w-6 h-6 text-black" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold text-white text-lg">I'm a Rep</p>
                            <p className="text-sm text-gray-400">Knock doors & log results</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-yellow-500 group-hover:translate-x-1 transition-transform" />
                    </div>
                </button>

                <button
                    onClick={() => selectRole('manager')}
                    className="w-full p-5 rounded-xl border border-gray-700 bg-gray-900 hover:bg-gray-800 transition-all text-left group"
                >
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-gray-700 rounded-xl flex items-center justify-center">
                            <Users className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex-1">
                            <p className="font-bold text-white text-lg">I'm a Manager</p>
                            <p className="text-sm text-gray-400">Plan routes & manage team</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-gray-500 group-hover:translate-x-1 transition-transform" />
                    </div>
                </button>
            </div>

            <p className="text-xs text-gray-600 mt-8">
                You can change this later in settings
            </p>
        </div>
    );
}