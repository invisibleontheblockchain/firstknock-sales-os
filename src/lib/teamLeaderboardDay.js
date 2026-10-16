const dayFormatters = new Map();

// Browser reporting uses the same local calendar keys as the team backend.
export function leaderboardDayKey(value, timeZone = 'UTC') {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    if (!dayFormatters.has(timeZone)) dayFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }));
    const parts = Object.fromEntries(dayFormatters.get(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}
