export const parseResult = (input) => {
    if (!input) return { status: 'ELIGIBLE', nextDate: null };

    const lowerInput = input.toLowerCase();
    const now = new Date();

    // SOLD: Matches /(sold|closed|signed|deal)/i
    if (/(sold|closed|signed|deal)/.test(lowerInput)) {
        return { status: 'SOLD', nextDate: null };
    }

    // NO ANSWER: Matches /(nh|n\/h|no answer|nobody)/i
    if (/(nh|n\/h|no answer|nobody)/.test(lowerInput)) {
        // Cooldown Rule: + 14 days
        const nextDate = new Date(now);
        nextDate.setDate(now.getDate() + 14);
        return { status: 'NO_ANSWER', nextDate: nextDate.toISOString() };
    }

    // HARD NO matches
    if (/(not interested|go away|dni)/.test(lowerInput) || /\bno\b/.test(lowerInput)) {
         return { status: 'HARD_NO', nextDate: null };
    }

    // CALLBACK: Matches /(back|return|later|tomorrow)/i
    if (/(back|return|later|tomorrow)/.test(lowerInput)) {
        let nextDate = null;
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);

        if (lowerInput.includes('tomorrow')) {
            nextDate = tomorrow;
        } else {
            nextDate = tomorrow;
        }
        
        return { status: 'CALLBACK', nextDate: nextDate.toISOString() };
    }

    return { status: 'ELIGIBLE', nextDate: null };
};