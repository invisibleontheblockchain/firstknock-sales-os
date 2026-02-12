import React, { useState, useRef, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Send, MessageCircle, Users, Megaphone } from 'lucide-react';
import { format } from 'date-fns';

export default function TeamChat({ user, teamMember, onClose }) {
    const queryClient = useQueryClient();
    const [message, setMessage] = useState('');
    const [showMembers, setShowMembers] = useState(false);
    const scrollRef = useRef(null);
    
    // Determine channel - use manager_id for team-specific chat
    const channel = teamMember?.manager_id || 'general';

    // Fetch team members in same team
    const { data: teamMembers = [] } = useQuery({
        queryKey: ['chatTeamMembers', channel],
        queryFn: async () => {
            if (!channel || channel === 'general') return [];
            const res = await base44.entities.TeamMember.filter(
                { manager_id: channel },
                '-created_date',
                50
            );
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!channel,
    });

    const { data: messages = [], isLoading } = useQuery({
        queryKey: ['teamMessages', channel],
        queryFn: async () => {
            const res = await base44.entities.TeamMessage.filter(
                { channel },
                'created_date',
                100
            );
            return Array.isArray(res) ? res : (res?.items || []);
        },
        refetchInterval: 5000, // Poll every 5 seconds
    });

    // Subscribe for real-time updates
    useEffect(() => {
        const unsubscribe = base44.entities.TeamMessage.subscribe((event) => {
            if (event.data?.channel === channel) {
                queryClient.invalidateQueries({ queryKey: ['teamMessages', channel] });
            }
        });
        return unsubscribe;
    }, [channel, queryClient]);

    // Auto scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const sendMutation = useMutation({
        mutationFn: (msg) => base44.entities.TeamMessage.create(msg),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['teamMessages', channel] });
            setMessage('');
        }
    });

    const handleSend = () => {
        if (!message.trim()) return;
        sendMutation.mutate({
            sender_name: user?.full_name || 'Unknown',
            sender_email: user?.email,
            sender_role: user?.app_role || teamMember?.role || 'rep',
            channel,
            message: message.trim(),
            message_type: 'text',
        });
    };

    const isMe = (msg) => msg.sender_email === user?.email || msg.created_by === user?.email;

    return (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col" onClick={onClose}>
            <div className="flex-1 flex flex-col max-h-full" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="bg-black/95 backdrop-blur border-b border-gray-800">
                    <div className="px-5 py-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center">
                                <Users className="w-5 h-5 text-blue-400" />
                            </div>
                            <div>
                                <h2 className="font-bold text-white text-sm">Team Chat</h2>
                                <p className="text-[10px] text-gray-500">{messages.length} messages</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {teamMembers.length > 0 && (
                                <button 
                                    onClick={() => setShowMembers(!showMembers)}
                                    className="h-8 px-3 rounded-full bg-gray-800 flex items-center gap-1.5 text-[10px] font-bold text-gray-400 hover:text-white transition-colors"
                                >
                                    <Users className="w-3 h-3" />
                                    {teamMembers.length}
                                </button>
                            )}
                            <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center">
                                <X className="w-4 h-4 text-gray-400" />
                            </button>
                        </div>
                    </div>

                    {/* Team Members Row */}
                    {showMembers && teamMembers.length > 0 && (
                        <div className="px-4 pb-3 flex gap-3 overflow-x-auto no-scrollbar">
                            {teamMembers.map(m => {
                                const isOnline = m.status === 'active';
                                const isCurrentUser = m.email?.toLowerCase() === user?.email?.toLowerCase();
                                const initials = (m.name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                                return (
                                    <div key={m.id} className="flex flex-col items-center shrink-0 min-w-[52px]">
                                        <div className="relative">
                                            <div 
                                                className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold ${
                                                    isCurrentUser ? 'bg-yellow-500 text-black' : 'bg-gray-800 text-white'
                                                }`}
                                                style={m.color ? { borderColor: m.color, borderWidth: 2 } : {}}
                                            >
                                                {initials}
                                            </div>
                                            {isOnline && (
                                                <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-black" />
                                            )}
                                        </div>
                                        <span className="text-[9px] text-gray-500 mt-1 truncate max-w-[52px] text-center">
                                            {isCurrentUser ? 'You' : (m.name || '').split(' ')[0]}
                                        </span>
                                        {m.role === 'manager' && (
                                            <span className="text-[8px] text-blue-400 font-bold">MGR</span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Messages */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
                    {isLoading && (
                        <div className="text-center py-10">
                            <div className="w-8 h-8 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin mx-auto" />
                        </div>
                    )}

                    {!isLoading && messages.length === 0 && (
                        <div className="text-center py-16">
                            <MessageCircle className="w-12 h-12 text-gray-700 mx-auto mb-3" />
                            <p className="text-gray-500 font-medium">No messages yet</p>
                            <p className="text-gray-600 text-xs mt-1">Be the first to say hi!</p>
                        </div>
                    )}

                    {messages.map((msg) => {
                        const mine = isMe(msg);
                        const isAlert = msg.message_type === 'alert';
                        const isCelebration = msg.message_type === 'celebration';

                        if (isAlert) {
                            return (
                                <div key={msg.id} className="flex justify-center">
                                    <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-full px-4 py-1.5 flex items-center gap-2">
                                        <Megaphone className="w-3 h-3 text-yellow-500" />
                                        <span className="text-xs text-yellow-400 font-medium">{msg.message}</span>
                                    </div>
                                </div>
                            );
                        }

                        return (
                            <div key={msg.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[80%] ${mine ? 'order-2' : 'order-1'}`}>
                                    {!mine && (
                                        <p className="text-[10px] text-gray-500 font-bold mb-1 ml-1">
                                            {msg.sender_name}
                                            {msg.sender_role === 'manager' && (
                                                <span className="text-blue-400 ml-1">MGR</span>
                                            )}
                                        </p>
                                    )}
                                    <div className={`rounded-2xl px-4 py-2.5 ${
                                        mine 
                                            ? 'bg-yellow-500 text-black rounded-br-sm' 
                                            : 'bg-[#1a1a1a] text-white border border-gray-800 rounded-bl-sm'
                                    } ${isCelebration ? 'ring-2 ring-green-500/50' : ''}`}>
                                        <p className="text-sm leading-relaxed">
                                            {isCelebration && '🎉 '}{msg.message}
                                        </p>
                                    </div>
                                    <p className={`text-[9px] text-gray-600 mt-1 ${mine ? 'text-right mr-1' : 'ml-1'}`}>
                                        {msg.created_date ? format(new Date(msg.created_date), 'h:mm a') : ''}
                                    </p>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Input */}
                <div className="bg-black border-t border-gray-800 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
                    <div className="flex items-center gap-2">
                        <input
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }}}
                            placeholder="Type a message..."
                            className="flex-1 bg-[#1a1a1a] border border-gray-800 rounded-full px-4 py-3 text-sm text-white placeholder:text-gray-600 focus:border-yellow-500 focus:outline-none"
                        />
                        <button
                            onClick={handleSend}
                            disabled={!message.trim() || sendMutation.isPending}
                            className="w-11 h-11 rounded-full bg-yellow-500 flex items-center justify-center active:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                        >
                            <Send className="w-4 h-4 text-black" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}