import React, { useRef, useEffect, useState } from 'react';
import { Send, Megaphone, ArrowLeft, Users, PartyPopper } from 'lucide-react';
import { format } from 'date-fns';

export default function MessageThread({
    messages,
    isLoading,
    user,
    channelName,
    channelMembers,
    onSend,
    onBack,
    isSending
}) {
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState('text');
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSend = () => {
        if (!message.trim()) return;
        onSend(message.trim(), messageType);
        setMessage('');
        setMessageType('text');
    };

    const isMe = (msg) => msg.sender_email === user?.email || msg.created_by === user?.email;

    const groupByDate = (msgs) => {
        const groups = {};
        msgs.forEach(msg => {
            const date = msg.created_date
                ? format(new Date(msg.created_date), 'MMM d, yyyy')
                : 'Unknown';
            if (!groups[date]) groups[date] = [];
            groups[date].push(msg);
        });
        return groups;
    };

    const grouped = groupByDate(messages);

    return (
        <div className="flex flex-col h-full bg-[#0a0a0f]">
            {/* Header */}
            <div className="bg-black/95 backdrop-blur border-b border-white/5 shrink-0">
                <div className="px-4 py-3 flex items-center gap-3">
                    <button
                        onClick={onBack}
                        className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center md:hidden"
                    >
                        <ArrowLeft className="w-4 h-4 text-gray-400" />
                    </button>
                    <div className="w-9 h-9 rounded-full bg-blue-600/20 flex items-center justify-center shrink-0">
                        <Users className="w-4 h-4 text-blue-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="font-bold text-white text-sm truncate">{channelName}</h2>
                        <p className="text-[10px] text-gray-500">
                            {channelMembers?.length || 0} members · {messages.length} messages
                        </p>
                    </div>
                </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
                {isLoading && (
                    <div className="text-center py-10">
                        <div className="w-8 h-8 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin mx-auto" />
                    </div>
                )}

                {!isLoading && messages.length === 0 && (
                    <div className="text-center py-16">
                        <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-3">
                            <Users className="w-7 h-7 text-gray-700" />
                        </div>
                        <p className="text-gray-500 font-medium text-sm">No messages yet</p>
                        <p className="text-gray-600 text-xs mt-1">Be the first to say hi!</p>
                    </div>
                )}

                {Object.entries(grouped).map(([date, msgs]) => (
                    <div key={date}>
                        <div className="flex items-center gap-3 py-3">
                            <div className="flex-1 h-px bg-white/5" />
                            <span className="text-[10px] text-gray-600 font-medium">{date}</span>
                            <div className="flex-1 h-px bg-white/5" />
                        </div>
                        <div className="space-y-1.5">
                            {msgs.map((msg) => {
                                const mine = isMe(msg);
                                const isAlert = msg.message_type === 'alert';
                                const isCelebration = msg.message_type === 'celebration';
                                const isSystem = msg.message_type === 'system';

                                if (isAlert || isSystem) {
                                    return (
                                        <div key={msg.id} className="flex justify-center py-1">
                                            <div className={`${isAlert ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-white/5 border-white/10'} border rounded-full px-4 py-1.5 flex items-center gap-2`}>
                                                <Megaphone className={`w-3 h-3 ${isAlert ? 'text-yellow-500' : 'text-gray-500'}`} />
                                                <span className={`text-xs font-medium ${isAlert ? 'text-yellow-400' : 'text-gray-400'}`}>{msg.message}</span>
                                            </div>
                                        </div>
                                    );
                                }

                                return (
                                    <div key={msg.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[80%] ${mine ? 'order-2' : 'order-1'}`}>
                                            {!mine && (
                                                <p className="text-[10px] text-gray-500 font-bold mb-1 ml-3">
                                                    {msg.sender_name}
                                                    {msg.sender_role === 'manager' && (
                                                        <span className="text-blue-400 ml-1">MGR</span>
                                                    )}
                                                </p>
                                            )}
                                            <div className={`rounded-2xl px-4 py-2.5 ${
                                                mine
                                                    ? 'bg-blue-600 text-white rounded-br-md'
                                                    : 'bg-[#1a1a22] text-white border border-white/5 rounded-bl-md'
                                            } ${isCelebration ? 'ring-2 ring-green-500/40' : ''}`}>
                                                <p className="text-sm leading-relaxed">
                                                    {isCelebration && '🎉 '}{msg.message}
                                                </p>
                                            </div>
                                            <p className={`text-[9px] text-gray-600 mt-1 ${mine ? 'text-right mr-3' : 'ml-3'}`}>
                                                {msg.created_date ? format(new Date(msg.created_date), 'h:mm a') : ''}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>

            {/* Message Type + Input */}
            <div className="bg-black border-t border-white/5 p-3 pb-[max(12px,env(safe-area-inset-bottom))] shrink-0">
                {/* Type selector */}
                <div className="flex items-center gap-1.5 mb-2">
                    {[
                        { id: 'text', label: 'Message' },
                        { id: 'alert', label: '📢 Alert' },
                        { id: 'celebration', label: '🎉 Celebrate' },
                    ].map(t => (
                        <button
                            key={t.id}
                            onClick={() => setMessageType(t.id)}
                            className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition-all ${
                                messageType === t.id
                                    ? 'bg-white/15 text-white'
                                    : 'text-gray-600 hover:text-gray-400'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2">
                    <input
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                        placeholder={messageType === 'alert' ? 'Send an alert...' : messageType === 'celebration' ? 'Celebrate something...' : 'Type a message...'}
                        className="flex-1 bg-[#1a1a22] border border-white/5 rounded-full px-4 py-3 text-sm text-white placeholder:text-gray-600 focus:border-blue-500/50 focus:outline-none"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!message.trim() || isSending}
                        className="w-11 h-11 rounded-full bg-blue-600 flex items-center justify-center active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    >
                        <Send className="w-4 h-4 text-white" />
                    </button>
                </div>
            </div>
        </div>
    );
}