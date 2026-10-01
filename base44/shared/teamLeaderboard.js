const DAY_MS = 86400000;
const normalized = (value) => String(value || '').trim().toLowerCase();
const dayFormatters = new Map();

export function leaderboardDayKey(value, timeZone = 'UTC') {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    if (!dayFormatters.has(timeZone)) dayFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }));
    const parts = dayFormatters.get(timeZone).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
}

export function isLeaderboardLogInPeriod(log, period, timeZone, now, today = Date.parse(leaderboardDayKey(now, timeZone))) {
    if (log?.counts_as_knock === false || !log?.created_date) return false;
    const date = new Date(log.created_date);
    if (!Number.isFinite(date.getTime()) || date > now) return false;
    if (period === 'all') return true;
    const days = (today - Date.parse(leaderboardDayKey(date, timeZone))) / DAY_MS;
    const limit = { today: 1, week: 7, month: 30 }[period];
    return days >= 0 && days < limit;
}

function indexIdentity(index, key, row) {
    if (!key) return;
    if (index.has(key) && index.get(key) !== row) index.set(key, null);
    else if (!index.has(key)) index.set(key, row);
}

export function buildTeamLeaderboard({ members = [], logs = [], period = 'today', timeZone = 'UTC', now = new Date() }) {
    const today = Date.parse(leaderboardDayKey(now, timeZone));
    const membersById = new Map(members.map((member) => [member.id, member]));
    const rows = members.filter((member) => normalized(member.status || 'active') !== 'inactive').map((member) => ({
        id: member.id,
        name: member.name || 'Team Member',
        email: member.email || '',
        role: member.role || 'rep',
        color: member.color || '#FFD700',
        metrics: { sales: 0, knocks: 0, conversion: 0, doorsPerHour: 0 },
        history: Array.from({ length: 7 }, (_, i) => ({ date: new Date(today - (6 - i) * DAY_MS).toISOString().slice(0, 10), score: 0 })),
        hours: new Set(),
    }));
    const byId = new Map();
    const byEmail = new Map();
    rows.forEach((row) => {
        const member = membersById.get(row.id);
        indexIdentity(byId, row.id, row);
        indexIdentity(byId, member?.user_id, row);
        indexIdentity(byEmail, normalized(row.email), row);
    });
    const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    for (const log of logs) {
        if (!isLeaderboardLogInPeriod(log, period, timeZone, now, today)) continue;
        const id = String(log.rep_id || log.actor_user_id || '').trim();
        const row = byId.has(id) ? byId.get(id) : byEmail.get(normalized(log.created_by));
        if (!row) continue;
        const date = leaderboardDayKey(log.created_date, timeZone);
        row.metrics.knocks += 1;
        row.hours.add(`${date}-${hourFormatter.format(new Date(log.created_date))}`);
        if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) {
            row.metrics.sales += 1;
            const day = row.history.find((item) => item.date === date);
            if (day) day.score += 1;
        }
    }
    for (const row of rows) {
        row.metrics.conversion = row.metrics.knocks ? row.metrics.sales / row.metrics.knocks * 100 : 0;
        row.metrics.doorsPerHour = row.hours.size ? row.metrics.knocks / row.hours.size : 0;
        delete row.hours;
    }
    return rows.sort((a, b) => b.metrics.sales - a.metrics.sales || b.metrics.knocks - a.metrics.knocks || a.name.localeCompare(b.name));
}

