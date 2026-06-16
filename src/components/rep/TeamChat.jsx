import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ChevronLeft } from 'lucide-react';
import ChannelList from '@/components/chat/ChannelList';
import MessageThread from '@/components/chat/MessageThread';

export default function TeamChat({ user, teamMember, onClose }) {
    const queryClient = useQueryClient();
    const [activeChannel, setActiveChannel] = useState(null);
    const [mobileView, setMobileView] = useState('channels'); // 'channels' | 'thread'

    const normalizeEmail = (email) => (email || '').trim().toLowerCase();
    const teamChannel = teamMember?.manager_id || user?.team_manager_id || (user?.app_role === 'manager' ? user?.id : null);

    // Fetch team members
    const { data: teamMembers = [] } = useQuery({
        queryKey: ['chatTeamMembers', teamChannel],
        queryFn: async () => {
            if (!teamChannel) return [];
            const res = await base44.entities.TeamMember.filter(
                { manager_id: teamChannel }, '-created_date', 50
            );
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!teamChannel,
    });

    // Fetch custom groups
    const { data: chatGroups = [] } = useQuery({
        queryKey: ['chatGroups', user?.email],
        queryFn: async () => {
            const res = await base44.entities.ChatGroup.list('-created_date', 100);
            const all = Array.isArray(res) ? res : (res?.items || []);
            return all.filter(g => g.is_active !== false && g.member_emails?.includes(user?.email?.toLowerCase()));
        },
        enabled: !!user?.email,
    });

    // Build channel list
    const channels = useMemo(() => {
        const list = [];

        // General channel (always visible)
        if (teamChannel) {
            list.push({
                id: teamChannel,
                name: '🏠 Team',
                type: 'team'
            });
        }

        if (teamChannel) {
            list.push({
                id: `general_${teamChannel}`,
                name: '💬 General',
                type: 'general'
            });
        }

        // Custom groups
        chatGroups.forEach(g => {
            list.push({
                id: `group_${g.id}`,
                name: g.name,
                type: 'group',
                members: g.member_emails
            });
        });

        // DMs with team members
        teamMembers
            .filter(m => m.email?.toLowerCase() !== user?.email?.toLowerCase())
            .forEach(m => {
                const emails = [normalizeEmail(user.email), normalizeEmail(m.email)].sort();
                const dmId = `dm_${emails.join('_')}`;
                list.push({
                    id: dmId,
                    name: m.name || m.email,
                    type: 'dm',
                    members: [m.email]
                });
            });

        return list;
    }, [teamChannel, chatGroups, teamMembers, user?.email]);

    const getChannelParticipants = (channel) => {
        if (!channel) return [];
        if (channel.type === 'dm' || channel.type === 'group') {
            return [...new Set([normalizeEmail(user?.email), ...(channel.members || []).map(normalizeEmail)].filter(Boolean))];
        }
        return [...new Set([normalizeEmail(user?.email), ...teamMembers.map(m => normalizeEmail(m.email))].filter(Boolean))];
    };

    // Default to team channel
    useEffect(() => {
        if (!activeChannel && channels.length > 0) {
            setActiveChannel(channels[0].id);
        }
    }, [channels, activeChannel]);

    // Fetch messages for active channel
    const { data: messages = [], isLoading: msgsLoading } = useQuery({
        queryKey: ['teamMessages', teamChannel, activeChannel],
        queryFn: async () => {
            if (!activeChannel || !teamChannel) return [];
            const res = await base44.entities.TeamMessage.filter(
                { channel: activeChannel, manager_id: teamChannel }, 'created_date', 200
            );
            return Array.isArray(res) ? res : (res?.items || []);
        },
        refetchInterval: 30000, // safety-net only — real-time delivery comes from the TeamMessage subscription below
        enabled: !!activeChannel && !!teamChannel,
    });

    // Real-time subscription
    useEffect(() => {
        const unsubscribe = base44.entities.TeamMessage.subscribe((event) => {
            if (event.data?.channel === activeChannel && event.data?.manager_id === teamChannel) {
                queryClient.invalidateQueries({ queryKey: ['teamMessages', teamChannel, activeChannel] });
            }
        });
        return unsubscribe;
    }, [activeChannel, teamChannel, queryClient]);

    const sendMutation = useMutation({
        mutationFn: (msg) => base44.entities.TeamMessage.create(msg),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['teamMessages', teamChannel, activeChannel] });
        }
    });

    const handleSend = (text, type) => {
        if (!text.trim() || !activeChannel) return;
        const activeChannelObj = channels.find(c => c.id === activeChannel);
        sendMutation.mutate({
            sender_name: user?.full_name || 'Unknown',
            sender_email: normalizeEmail(user?.email),
            sender_role: user?.app_role || teamMember?.role || 'rep',
            manager_id: teamChannel,
            participant_emails: getChannelParticipants(activeChannelObj),
            channel: activeChannel,
            channel_name: activeChannelObj?.name || activeChannel,
            message: text.trim(),
            message_type: type || 'text',
        });
    };

    const handleCreateGroup = async (name, memberEmails) => {
        await base44.entities.ChatGroup.create({
            name,
            member_emails: memberEmails.map(normalizeEmail),
            manager_id: teamChannel,
            is_active: true,
        });
        queryClient.invalidateQueries({ queryKey: ['chatGroups'] });
        // Send system message
        const groupId = `group_${Date.now()}`;
        // The channel id will be updated after refetch
    };

    const activeChannelObj = channels.find(c => c.id === activeChannel);
    const channelMembers = activeChannelObj?.type === 'dm'
        ? activeChannelObj.members
        : activeChannelObj?.type === 'group'
            ? activeChannelObj.members
            : getChannelParticipants(activeChannelObj);

    const selectChannel = (id) => {
        setActiveChannel(id);
        setMobileView('thread');
    };

    return (
        <div className="fixed left-0 right-0 top-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-0 z-50 bg-black/95 backdrop-blur-md flex flex-col" onClick={onClose}>
            <div className="flex-1 flex max-h-full min-h-0" onClick={e => e.stopPropagation()}>

                {/* Desktop: Side-by-side layout */}
                {/* Mobile: Toggle between channels and thread */}

                {/* Channel List - always visible on desktop, toggle on mobile */}
                <div className={`w-full md:w-72 md:border-r md:border-white/5 shrink-0 ${
                    mobileView === 'channels' ? 'flex flex-col' : 'hidden md:flex md:flex-col'
                }`}>
                    {/* Close button on mobile */}
                    <div className="flex items-center justify-between p-4 md:hidden border-b border-white/5">
                        <h2 className="font-bold text-white text-lg">Messages</h2>
                        <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center">
                            <X className="w-4 h-4 text-gray-400" />
                        </button>
                    </div>
                    <div className="hidden md:flex items-center justify-between px-4 pt-3">
                        <span></span>
                        <button onClick={onClose} className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10">
                            <X className="w-3.5 h-3.5 text-gray-400" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <ChannelList
                            channels={channels}
                            activeChannel={activeChannel}
                            onSelectChannel={selectChannel}
                            onCreateGroup={handleCreateGroup}
                            teamMembers={teamMembers}
                            user={user}
                            unreadCounts={{}}
                        />
                    </div>
                </div>

                {/* Message Thread */}
                <div className={`flex-1 flex flex-col min-w-0 ${
                    mobileView === 'thread' ? 'flex' : 'hidden md:flex'
                }`}>
                    {activeChannel ? (
                        <MessageThread
                            messages={messages}
                            isLoading={msgsLoading}
                            user={user}
                            channelName={activeChannelObj?.name || 'Chat'}
                            channelMembers={channelMembers}
                            onSend={handleSend}
                            onBack={() => setMobileView('channels')}
                            isSending={sendMutation.isPending}
                        />
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <p className="text-gray-600 text-sm">Select a channel</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}