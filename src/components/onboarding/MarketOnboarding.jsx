import React from 'react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from "@tanstack/react-query";

export default function MarketOnboarding({ user, onComplete }) {
    const queryClient = useQueryClient();
    const autoStartedRef = React.useRef(false);

    React.useEffect(() => {
        if (!user || user.app_role !== 'manager') return;
        if (autoStartedRef.current) return;
        if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('startDraw') === 'true') return;

        const hasExistingTerritory = user.has_pulled_data || user.has_defined_market || user.territory_zip_codes?.length > 0 || user.area_pulls_count > 0;
        if (hasExistingTerritory) return;

        autoStartedRef.current = true;
        const startDrawing = async () => {
            await base44.auth.updateMe({
                has_seen_onboarding: true,
                has_defined_market: true,
                pull_months_back: user.pull_months_back || 12
            });
            await queryClient.invalidateQueries({ queryKey: ['user'] });
            onComplete?.({ method: 'draw' });
        };

        startDrawing();
    }, [user, queryClient, onComplete]);

    return null;
}