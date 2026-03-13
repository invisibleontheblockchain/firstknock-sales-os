import React, { useState, useRef, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageSquare, Send, X, Bot, Loader2, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from "framer-motion";

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
                    className="fixed bottom-20 md:bottom-24 right-4 z-50 w-12 h-12 md:w-14 md:h-14 rounded-full shadow-2xl flex items-center justify-center bg-gradient-to-br from-yellow-400 to-yellow-600 text-black border-2 border-yellow-200"
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
                        className="fixed bottom-20 md:bottom-24 right-4 z-50 w-[calc(100vw-32px)] md:w-[400px] h-[60vh] md:h-[500px] max-h-[600px] bg-[#111] border border-yellow-500/30 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
                    >
                        {/* Header */}
                        <div className="p-4 bg-gradient-to-r from-yellow-500 to-yellow-600 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-black font-bold">
                                <Bot className="w-6 h-6" />
                                <span>FirstKnock AI</span>
                            </div>
                            <button 
                                onClick={() => setIsOpen(false)}
                                className="p-1 rounded-full hover:bg-black/10 text-black transition-colors"
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
                                        className={`max-w-[80%] p-3 rounded-2xl text-sm ${
                                            msg.role === 'user' 
                                                ? 'bg-yellow-500 text-black rounded-tr-none font-medium' 
                                                : 'bg-[#222] text-white rounded-tl-none border border-gray-800'
                                        }`}
                                    >
                                        {msg.content}
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
                                className="bg-[#222] border-gray-700 text-white focus:border-yellow-500"
                            />
                            <Button 
                                type="submit" 
                                disabled={isLoading || !input.trim()}
                                className="bg-yellow-500 text-black hover:bg-yellow-400"
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