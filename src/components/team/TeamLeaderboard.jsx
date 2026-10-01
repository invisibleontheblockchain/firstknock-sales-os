import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trophy, Flame, Target, Clock } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { useTeamLeaderboard } from '@/lib/useTeamLeaderboard';

export default function TeamLeaderboard({ members, currentUser, onSelectRep }) {
    const [period, setPeriod] = useState('today'); // Reset to Today on each opening.

    const { data: rankedMembers = [], isLoading, isError, refetch } = useTeamLeaderboard(currentUser, period);
    const leaderboardData = useMemo(
        () => rankedMembers.filter(row => members.some(member => member.id === row.id)),
        [rankedMembers, members]
    );

    const MetricCard = ({ rank, rep, type }) => (
        <div
            role={onSelectRep ? 'button' : undefined}
            onClick={onSelectRep ? () => onSelectRep(members.find(m => m.id === rep.id)) : undefined}
            className={`flex items-center justify-between p-2 md:p-3 bg-[#1F1F1F] rounded-lg border border-gray-800 mb-1.5 md:mb-2 ${onSelectRep ? 'cursor-pointer transition-colors hover:border-yellow-500/40 hover:bg-[#262626]' : ''}`}
        >
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
                <div className={`w-5 h-5 md:w-6 md:h-6 flex items-center justify-center rounded-full font-bold text-[10px] md:text-xs shrink-0 ${
                    rank === 1 ? 'bg-yellow-500 text-black' : 
                    rank === 2 ? 'bg-gray-400 text-black' : 
                    rank === 3 ? 'bg-orange-700 text-white' : 'bg-gray-800 text-gray-400'
                }`}>
                    {rank}
                </div>
                <Avatar className="h-6 w-6 md:h-8 md:w-8 border border-gray-700 shrink-0">
                    <AvatarFallback style={{ backgroundColor: rep.color }}>{rep.name[0]}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                    <p className="text-xs md:text-sm font-bold text-white truncate">{rep.name}</p>
                    <p className="text-[9px] md:text-[10px] text-gray-500 truncate">{rep.role}</p>
                </div>
            </div>
            <div className="text-right shrink-0">
                <p className="text-base md:text-lg font-bold text-white">
                    {type === 'sales' && rep.metrics.sales}
                    {type === 'conversion' && `${rep.metrics.conversion.toFixed(1)}%`}
                    {type === 'speed' && rep.metrics.doorsPerHour.toFixed(1)}
                </p>
                <div className="h-5 w-16 md:h-6 md:w-20">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={rep.history}>
                            <Area type="monotone" dataKey="score" stroke={rep.color || '#FCD34D'} fill={rep.color || '#FCD34D'} fillOpacity={0.2} strokeWidth={2} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );

    return (
        <Card className="bg-[#111] border-gray-800 h-full">
            <CardHeader className="pb-2 border-b border-gray-800 px-3 md:px-6">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-xs md:text-sm font-bold text-gray-400 uppercase flex items-center gap-2">
                        <Trophy className="w-3.5 h-3.5 md:w-4 md:h-4 text-yellow-500" /> Leaderboard
                    </CardTitle>
                    <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
                        {['today', 'week', 'month', 'all'].map(p => (
                            <button
                                key={p}
                                onClick={() => setPeriod(p)}
                                aria-pressed={period === p}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase transition-all ${
                                    period === p ? 'bg-yellow-500 text-black' : 'text-gray-500 hover:text-white'
                                }`}
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="p-2.5 md:p-4">
                {isLoading ? (
                    <p className="py-6 text-center text-sm text-gray-500">Loading leaderboard...</p>
                ) : isError ? (
                    <div role="alert" className="py-6 text-center text-sm text-gray-400">
                        <p>Couldn’t load the leaderboard.</p>
                        <button onClick={() => refetch()} className="mt-2 font-bold text-yellow-500">Retry</button>
                    </div>
                ) : (
                <Tabs defaultValue="sales" className="w-full">
                    <TabsList className="w-full bg-[#1F1F1F] mb-4">
                        <TabsTrigger value="sales" className="flex-1 text-xs">
                            <Flame className="w-3 h-3 mr-1" /> Sales
                        </TabsTrigger>
                        <TabsTrigger value="conversion" className="flex-1 text-xs">
                            <Target className="w-3 h-3 mr-1" /> Conv. %
                        </TabsTrigger>
                        <TabsTrigger value="speed" className="flex-1 text-xs">
                            <Clock className="w-3 h-3 mr-1" /> Speed
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="sales">
                        {leaderboardData.map((rep, idx) => (
                            <MetricCard key={rep.id} rank={idx + 1} rep={rep} type="sales" />
                        ))}
                    </TabsContent>
                    
                    <TabsContent value="conversion">
                        {[...leaderboardData].sort((a,b) => b.metrics.conversion - a.metrics.conversion).map((rep, idx) => (
                            <MetricCard key={rep.id} rank={idx + 1} rep={rep} type="conversion" />
                        ))}
                    </TabsContent>

                    <TabsContent value="speed">
                         {[...leaderboardData].sort((a,b) => b.metrics.doorsPerHour - a.metrics.doorsPerHour).map((rep, idx) => (
                            <MetricCard key={rep.id} rank={idx + 1} rep={rep} type="speed" />
                        ))}
                    </TabsContent>
                </Tabs>
                )}
            </CardContent>
        </Card>
    );
}