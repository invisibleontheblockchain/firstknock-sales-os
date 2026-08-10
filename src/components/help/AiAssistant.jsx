import React, { useState, useRef, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, X, Bot } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from "framer-motion";
import AssistantMessage from '@/components/help/AssistantMessage';

export default function AiAssistant() {
    const path = typeof window !== 'undefined' ? window.location.pathname : '';
    const isMapPage = path.endsWith('Home') || path === '/' || path.endsWith('RepHome');

    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState([
        { role: 'system', content: 'Hi! I\'m your FirstKnock AI assistant. Ask me anything about using the platform, generating routes, or managing your team.' }
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isOpen]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMsg = input.trim();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsLoading(true);

        try {
            const res = await base44.functions.invoke('askAssistant', { question: userMsg });
            setMessages(prev => [...prev, { role: 'system', content: res.data.answer }]);
        } catch (error) {
            console.error(error);
            setMessages(prev => [...prev, { role: 'system', content: "Sorry, I'm having trouble connecting right now. Please try again." }]);
        } finally {
            setIsLoading(false);
        }
    };

    if (isMapPage) return null;

    return (
        <>
            {/* Toggle Button */}
            {!isOpen && (
                <motion.button
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => setIsOpen(true)}
                    className="fixed bottom-20 md:bottom-24 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-primary/40 bg-primary text-primary-foreground shadow-[0_10px_35px_rgba(46,235,87,0.35)] md:bottom-24 md:h-14 md:w-14"
                >
                    <Bot className="w-6 h-6 md:w-8 md:h-8" />
                    <div className="absolute -top-1 -right-1 w-3 h-3 md:w-4 md:h-4 bg-red-500 rounded-full animate-pulse" />
                </motion.button>
            )}

            {/* Chat Window */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.95 }}
                        className="fixed bottom-20 right-4 z-50 flex h-[60vh] max-h-[600px] w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-primary/25 bg-card shadow-[0_24px_80px_rgba(0,0,0,0.65)] md:bottom-24 md:h-[500px] md:w-[400px]"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between border-b border-primary/20 bg-primary p-4">
                            <div className="flex items-center gap-2 font-bold text-primary-foreground">
                                <Bot className="w-6 h-6" />
                                <span>FirstKnock AI</span>
                            </div>
                            <button 
                                onClick={() => setIsOpen(false)}
                                className="rounded-full p-1 text-primary-foreground transition-colors hover:bg-black/10"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#0A0A0A]">
                            {messages.map((msg, idx) => (
                                <div 
                                    key={idx} 
                                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div 
                                        className={`max-w-[84%] rounded-2xl p-3 text-sm ${
                                            msg.role === 'user'
                                                ? 'rounded-tr-none bg-primary font-medium text-primary-foreground'
                                                : 'rounded-tl-none border border-border bg-muted text-foreground'
                                        }`}
                                    >
                                        {msg.role === 'user' ? msg.content : <AssistantMessage content={msg.content} />}
                                    </div>
                                </div>
                            ))}
                            {isLoading && (
                                <div className="flex justify-start">
                                    <div className="bg-[#222] p-3 rounded-2xl rounded-tl-none border border-gray-800 flex gap-1">
                                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce delay-75" />
                                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce delay-150" />
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input */}
                        <form onSubmit={handleSubmit} className="p-3 bg-[#111] border-t border-gray-800 flex gap-2">
                            <Input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                placeholder="How do I create a route?"
                                className="border-border bg-muted text-foreground focus:border-primary"
                            />
                            <Button 
                                type="submit" 
                                disabled={isLoading || !input.trim()}
                                className="bg-primary text-primary-foreground hover:bg-accent"
                            >
                                <Send className="w-4 h-4" />
                            </Button>
                        </form>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}