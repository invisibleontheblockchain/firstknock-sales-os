import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Users, AlertTriangle, RefreshCw } from 'lucide-react';
import { createPageUrl } from '@/utils';

export default function AdminTeam() {
    const queryClient = useQueryClient();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me().catch(() => null) });
    
    // Simplified Data Fetching
    const { data: teamMembers = [], isLoading } = useQuery({
        queryKey: ['teamMembers'],
        queryFn: async () => {
            try {
                const res = await base44.entities.TeamMember.list('-created_date', 50);
                return Array.isArray(res) ? res : (res?.items || []);
            } catch (e) {
                console.error(e);
                return [];
            }
        }
    });

    const resetRole = async () => {
        if (confirm("Are you sure you want to reset your role? You will need to select Rep or Manager again.")) {
            await base44.auth.updateMe({ app_role: null });
            window.location.href = createPageUrl('RoleSelect');
        }
    };

    if (isLoading) {
        return <div className="p-10 text-white text-center">Loading Team...</div>;
    }

    return (
        <div className="min-h-screen bg-black text-white p-6">
            <div className="max-w-4xl mx-auto">
                <div className="flex justify-between items-center mb-8 border-b border-gray-800 pb-4">
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Users className="text-yellow-500" /> 
                        Admin Team
                    </h1>
                    <Button 
                        onClick={resetRole} 
                        variant="destructive"
                        className="bg-red-600 hover:bg-red-700 font-bold"
                    >
                        <RefreshCw className="w-4 h-4 mr-2" />
                        RESET MY ROLE
                    </Button>
                </div>

                {/* Safe Render of Content */}
                <div className="grid gap-4">
                    {teamMembers.length === 0 ? (
                        <div className="p-8 bg-gray-900 rounded-xl text-center border border-gray-800">
                            <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
                            <h3 className="text-xl font-bold mb-2">No Team Members Found</h3>
                            <p className="text-gray-400">Add team members to get started.</p>
                        </div>
                    ) : (
                        <div className="bg-gray-900 rounded-xl overflow-hidden border border-gray-800">
                            <table className="w-full text-left">
                                <thead className="bg-gray-800">
                                    <tr>
                                        <th className="p-4 font-bold text-gray-400">Name</th>
                                        <th className="p-4 font-bold text-gray-400">Email</th>
                                        <th className="p-4 font-bold text-gray-400">Role</th>
                                        <th className="p-4 font-bold text-gray-400">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {teamMembers.map(member => (
                                        <tr key={member.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                                            <td className="p-4 font-medium">{member.name}</td>
                                            <td className="p-4 text-gray-400">{member.email}</td>
                                            <td className="p-4 uppercase text-xs font-bold text-yellow-500">{member.role}</td>
                                            <td className="p-4">
                                                <span className="inline-block px-2 py-1 rounded text-[10px] font-bold bg-green-900 text-green-300">
                                                    {member.status}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
                
                <div className="mt-8 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
                    <h3 className="font-bold text-yellow-500 mb-2">Debug Options</h3>
                    <p className="text-sm text-gray-400 mb-4">
                        If you are seeing this page, the Admin Team module has been reset to "Safe Mode" to fix a crash. 
                        You can reset your role above to switch between Rep and Manager views.
                    </p>
                    <Button onClick={() => window.location.reload()} variant="outline" className="border-gray-700 text-white hover:bg-gray-800">
                        Force Reload
                    </Button>
                </div>
            </div>
        </div>
    );
}