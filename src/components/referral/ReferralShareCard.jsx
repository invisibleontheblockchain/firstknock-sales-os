import React from 'react';
import { Button } from "@/components/ui/button";
import { Copy, Share2, LinkIcon } from 'lucide-react';
import { toast } from "sonner";

export default function ReferralShareCard({ stats, accent, accentTxt }) {
    const code = stats.referral_code || '';
    const link = stats.referral_link || '';

    const copyToClipboard = (text, label) => {
        navigator.clipboard.writeText(text).then(() => {
            toast.success(`${label} copied!`);
        }).catch(() => {
            toast.error('Failed to copy');
        });
    };

    const handleShare = async () => {
        const shareData = {
            title: 'Join FirstKnock',
            text: `Use my referral code ${code} to join FirstKnock — the ultimate door-to-door sales territory manager!`,
            url: link,
        };
        if (navigator.share) {
            try { await navigator.share(shareData); } catch { /* cancelled */ }
        } else {
            copyToClipboard(link, 'Referral link');
        }
    };

    return (
        <div className="bg-[#111] border border-gray-800 rounded-xl p-5 space-y-4">
            <h3 className="text-xs font-bold text-gray-500 uppercase flex items-center gap-2">
                <LinkIcon className="w-3 h-3" /> Your Referral
            </h3>

            {/* Code */}
            <div>
                <p className="text-[10px] text-gray-500 mb-1">REFERRAL CODE</p>
                <div className="flex items-center gap-2">
                    <div className="flex-1 bg-black border border-gray-700 rounded-lg px-4 py-3 font-mono text-lg font-bold tracking-widest text-white">
                        {code}
                    </div>
                    <Button
                        onClick={() => copyToClipboard(code, 'Code')}
                        size="icon"
                        className="h-12 w-12 rounded-lg"
                        style={{ background: accent, color: accentTxt }}
                    >
                        <Copy className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* Link */}
            <div>
                <p className="text-[10px] text-gray-500 mb-1">REFERRAL LINK</p>
                <div className="flex items-center gap-2">
                    <div className="flex-1 bg-black border border-gray-700 rounded-lg px-3 py-2.5 text-xs text-gray-400 truncate">
                        {link}
                    </div>
                    <Button
                        onClick={() => copyToClipboard(link, 'Link')}
                        size="icon"
                        variant="outline"
                        className="h-10 w-10 rounded-lg border-gray-700 text-gray-300 hover:bg-gray-800"
                    >
                        <Copy className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            {/* Share Button */}
            <Button
                onClick={handleShare}
                className="w-full h-11 font-bold text-sm"
                style={{ background: accent, color: accentTxt }}
            >
                <Share2 className="w-4 h-4 mr-2" />
                Share with Friends
            </Button>
        </div>
    );
}