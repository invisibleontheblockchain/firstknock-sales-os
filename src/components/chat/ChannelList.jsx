import React, { useState } from 'react';
import { Hash, Users, Plus, X, MessageCircle, Lock, ChevronRight } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function ChannelList({
    channels,
    activeChannel,
    onSelectChannel,
    onCreateGroup,
    teamMembers,
    user,
    unreadCounts
}) {
    const [showCreate, setShowCreate] = useState(false);
    const [groupName, setGroupName] = useState('');
    const [selectedMembers, setSelectedMembers] = useState([]);

    const handleCreateGroup = () => {
        if (!groupName.trim() || selectedMembers.length === 0) return;
        onCreateGroup(groupName.trim(), [...selectedMembers, user?.email]);
        setGroupName('');
        setSelectedMembers([]);
        setShowCreate(false);
    };

    const toggleMember = (email) => {
        setSelectedMembers(prev =>
            prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email]
        );
    };

    return (
        <div className="flex flex-col h-full bg-[#0a0a0f]">
            <div className="p-4 border-b border-white/5">
                <h2 className="text-sm font-bold text-white tracking-wide">Channels</h2>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {channels.map(ch => {
                    const isActive = activeChannel === ch.id;
                    const unread = unreadCounts?.[ch.id] || 0;
                    return (
                        <button
                            key={ch.id}
                            onClick={() => onSelectChannel(ch.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                                isActive
                                    ? 'bg-white/10 text-white'
                                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                            }`}
                        >
                            {ch.type === 'dm' ? (
                                <MessageCircle className="w-4 h-4 shrink-0" />
                            ) : ch.type === 'group' ? (
                                <Users className="w-4 h-4 shrink-0" />
                            ) : (
                                <Hash className="w-4 h-4 shrink-0" />
                            )}
                            <span className="flex-1 text-sm font-medium truncate">{ch.name}</span>
                            {unread > 0 && (
                                <span className="w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                                    {unread > 9 ? '9+' : unread}
                                </span>
                            )}
                            <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
                        </button>
                    );
                })}
            </div>

            {/* Create Group */}
            <div className="p-3 border-t border-white/5">
                {!showCreate ? (
                    <button
                        onClick={() => setShowCreate(true)}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-all text-sm"
                    >
                        <Plus className="w-4 h-4" />
                        <span>New Group</span>
                    </button>
                ) : (
                    <div className="space-y-3 bg-white/5 rounded-xl p-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-white">Create Group</span>
                            <button onClick={() => setShowCreate(false)}>
                                <X className="w-4 h-4 text-gray-500" />
                            </button>
                        </div>
                        <Input
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            placeholder="Group name..."
                            className="h-8 text-xs bg-black/60 border-white/10 text-white"
                        />
                        <div className="max-h-32 overflow-y-auto space-y-1">
                            {teamMembers
                                .filter(m => m.email?.toLowerCase() !== user?.email?.toLowerCase())
                                .map(m => (
                                    <button
                                        key={m.id}
                                        onClick={() => toggleMember(m.email)}
                                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all ${
                                            selectedMembers.includes(m.email)
                                                ? 'bg-blue-500/20 text-blue-300'
                                                : 'text-gray-400 hover:bg-white/5'
                                        }`}
                                    >
                                        <div
                                            className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                                            style={{ backgroundColor: m.color || '#333', color: '#fff' }}
                                        >
                                            {(m.name || '?')[0]}
                                        </div>
                                        <span className="truncate">{m.name}</span>
                                    </button>
                                ))}
                        </div>
                        <Button
                            onClick={handleCreateGroup}
                            disabled={!groupName.trim() || selectedMembers.length === 0}
                            size="sm"
                            className="w-full h-8 text-xs"
                        >
                            Create ({selectedMembers.length} members)
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}