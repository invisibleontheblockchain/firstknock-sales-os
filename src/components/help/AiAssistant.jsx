import React, { useState, useRef, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, X, MessageSquareText, CircleUserRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from "framer-motion";
import AssistantMessage from '@/components/help/AssistantMessage';

const PRECISION_PLAN_QUESTION = /precision|build mode|area pull|zip code|pricing tier|free plan|pro plan/i;
const PRECISION_PLAN_ANSWER = 'Precision Pro is $99 per user per month and includes unlimited ZIP codes, unlimited route creation, and up to 1,000 Precision homes per monthly billing period after payment clears. The Free Plan also has unlimited ZIP codes and includes up to 50 homes on the initial Precision generation.';

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
            const answer = PRECISION_PLAN_QUESTION.test(userMsg)
                ? PRECISION_PLAN_ANSWER
                : (await base44.functions.invoke('askAssistant', { question: userMsg })).data.answer;
            setMessages(prev => [...prev, { role: 'system', content: answer }]);
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
            {!isOpen && (
                <motion.button
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setIsOpen(true)}
                    aria-label="Open FirstKnock AI"
                    className="fixed bottom-20 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--primary)] bg-black text-[color:var(--primary)] shadow-[0_10px_32px_rgba(0,0,0,0.7)] md:bottom-24 md:h-14 md:w-14"
                >
                    <MessageSquareText className="h-6 w-6 md:h-7 md:w-7" />
                </motion.button>
            )}

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.98 }}
                        className="fixed bottom-20 right-3 z-50 flex h-[calc(100dvh-9rem)] min-h-[460px] max-h-[860px] w-[calc(100vw-24px)] flex-col overflow-hidden rounded-md border border-white/10 bg-black shadow-[0_28px_90px_rgba(0,0,0,0.8)] sm:right-5 sm:w-[430px] md:bottom-20"
                    >
                        <div className="flex h-[88px] shrink-0 items-center justify-between border-b-[3px] border-[color:var(--primary)] bg-gradient-to-r from-[#171717] to-[#101010] px-6">
                            <div className="flex items-center gap-4 text-white">
                                <MessageSquareText className="h-7 w-7 text-white/35" strokeWidth={1.5} />
                                <span className="font-heading text-[28px] font-medium tracking-tight">FirstKnock AI</span>
                            </div>
                            <button
                                onClick={() => setIsOpen(false)}
                                aria-label="Close FirstKnock AI"
                                className="flex h-10 w-10 items-center justify-center text-white/35 transition-colors hover:text-white"
                            >
                                <X className="h-6 w-6" strokeWidth={1.5} />
                            </button>
                        </div>

                        <div className="flex-1 space-y-6 overflow-y-auto bg-black px-5 py-8">
                            {messages.map((msg, idx) => (
                                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'items-start justify-start gap-3'}`}>
                                    {msg.role !== 'user' && (
                                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#292929] text-white/70">
                                            <CircleUserRound className="h-6 w-6" strokeWidth={1.8} />
                                        </div>
                                    )}
                                    <div className={msg.role === 'user'
                                        ? 'max-w-[84%] rounded-xl border border-white/10 bg-gradient-to-br from-[#2B2B2B] to-[#181818] px-4 py-3 text-base leading-relaxed text-white/90 shadow-[0_8px_24px_rgba(0,0,0,0.35)]'
                                        : 'max-w-[82%] pt-0.5 text-base leading-relaxed text-white/70'}
                                    >
                                        {msg.role === 'user' ? msg.content : <AssistantMessage content={msg.content} />}
                                    </div>
                                </div>
                            ))}
                            {isLoading && (
                                <div className="flex items-center gap-3">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#292929] text-white/70">
                                        <CircleUserRound className="h-6 w-6" strokeWidth={1.8} />
                                    </div>
                                    <div className="flex gap-1.5 py-3">
                                        <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/30" />
                                        <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/30 delay-75" />
                                        <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/30 delay-150" />
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        <form onSubmit={handleSubmit} className="shrink-0 border-t border-white/10 bg-black p-3">
                            <div className="relative">
                                <Input
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="How do I create a route?"
                                    className="h-14 rounded-xl border-white/10 bg-gradient-to-r from-[#171717] to-[#202020] pl-4 pr-14 text-base text-white placeholder:text-white/45 focus-visible:ring-1 focus-visible:ring-[color:var(--primary)]"
                                />
                                <Button
                                    type="submit"
                                    variant="ghost"
                                    size="icon"
                                    disabled={isLoading || !input.trim()}
                                    aria-label="Send message"
                                    className="absolute right-2 top-1/2 h-10 w-10 -translate-y-1/2 text-[color:var(--primary)] hover:bg-transparent hover:text-[color:var(--primary)]"
                                >
                                    <Send className="h-6 w-6" strokeWidth={1.8} />
                                </Button>
                            </div>
                        </form>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}