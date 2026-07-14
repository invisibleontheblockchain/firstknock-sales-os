import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { base44 } from '@/api/base44Client';
import { Loader2, BrainCircuit, Clock } from 'lucide-react';

export default function RouteInsights() {
    const { data: insights, isLoading } = useQuery({
        queryKey: ['routeInsights'],
        queryFn: async () => {
            const res = await base44.functions.invoke('analyzeRouteInsights');
            return res.data;
        }
    });

    if (isLoading) {
        return <div className="p-4 text-center text-gray-500"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Analyzing territory data...</div>;
    }

    if (!insights) return null;

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Card className="bg-[#111] border-gray-800 md:col-span-1">
                <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-bold text-gray-500 uppercase flex items-center gap-2">
                        <Clock className="w-4 h-4 text-blue-500" /> Best Time to Knock
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-xl font-bold text-white">{insights.bestTime}</p>
                </CardContent>
            </Card>

            <Card className="bg-[#111] border-gray-800 md:col-span-2">
                <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-bold text-gray-500 uppercase flex items-center gap-2">
                        <BrainCircuit className="w-4 h-4 text-purple-500" /> AI Strategy Recommendation
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-gray-300 italic">"{insights.recommendation}"</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {insights.successPatterns?.map((pattern, i) => (
                            <Badge key={i} variant="secondary" className="bg-purple-500/10 text-purple-400 border-purple-500/20">
                                {pattern}
                            </Badge>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}