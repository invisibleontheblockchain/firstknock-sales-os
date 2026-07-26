import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const ENTITY_PAGE_SIZE = 1000;
const MAX_ENTITY_RECORDS = 100000;
const MAX_STRIPE_CUSTOMERS = 50000;
const MAX_STRIPE_SUBSCRIPTIONS = 20000;
const MAX_STRIPE_INVOICES = 50000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADOPTION_WINDOW_DAYS = 732;
const PLATFORM_HQ_VIEWER_IDS = new Set([
    '695eb764b077190880be21df',
    '6978c7229935cf40cde25086',
    '69cfceec85189c20b0f4e97a'
]);
const HIDDEN_PLATFORM_ANALYTICS_REP_NAMES = new Set([
    'irobot v2',
    'irobotv2',
    'nick cohen',
    'nicholas cohen',
    'cory larson'
]);
const PRECISION_DOOR_OUTCOMES = new Set([
    'sold',
    'hard_no',
    'callback',
    'no_answer',
    'not_moved_in',
    'dm_not_home',
    'qualified'
]);
const PRECISION_DECISION_MAKER_OUTCOMES = new Set(['sold', 'hard_no', 'callback', 'qualified']);
const CANVAS_DOOR_OUTCOMES = new Set([
    'sale',
    'not_interested',
    'callback',
    'appointment',
    'no_answer',
    'do_not_knock'
]);
const CANVAS_DECISION_MAKER_OUTCOMES = new Set(['sale', 'not_interested', 'callback', 'appointment']);

const PERIODS = [
    { id: '7d', days: 7 },
    { id: '30d', days: 30 },
    { id: '90d', days: 90 },
    { id: 'all', days: null }
];

function asArray(value: any) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function normalized(value: any) {
    return String(value || '').trim().toLowerCase();
}

function normalizedLeaderboardName(value: any) {
    return normalized(value).replace(/\s+/g, ' ');
}

function canViewPlatformCommandCenter(user: any) {
    if (!user) return false;
    return PLATFORM_HQ_VIEWER_IDS.has(String(user.id || '').trim());
}

function finiteNonNegative(value: any) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function timestamp(value: any) {
    if (!value) return null;
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? result : null;
}

function isoInstant(value: any) {
    if (typeof value !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
}

function stripeTimestamp(value: any) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function round(value: number, precision = 1) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

function closeRate(sales: number, knocks: number) {
    return knocks > 0 ? round((sales / knocks) * 100, 1) : 0;
}

function isPrecisionPhotoAudit(log: any) {
    return normalized(log?.raw_input_text) === 'photo proof uploaded';
}

function precisionTextSignalsNoDecisionMaker(log: any) {
    const text = normalized(log?.raw_input_text);
    return /\b(no answer|nobody|not home|not moved in|dm not home)\b/.test(text)
        || /\bdecision maker\b.*\bnot home\b/.test(text);
}

function isPrecisionDoorOutcome(log: any) {
    return log?.counts_as_knock !== false
        && PRECISION_DOOR_OUTCOMES.has(normalized(log?.parsed_status))
        && !isPrecisionPhotoAudit(log);
}

function isPrecisionDecisionMakerConversation(log: any) {
    return isPrecisionDoorOutcome(log)
        && PRECISION_DECISION_MAKER_OUTCOMES.has(normalized(log?.parsed_status))
        // Older voice and CSV writers could persist "no answer" phrases as HARD_NO.
        // The raw text lets HQ conservatively keep those out of the contact denominator.
        && !precisionTextSignalsNoDecisionMaker(log);
}

function isCanvasDoorOutcome(event: any) {
    return normalized(event?.write_status) === 'committed'
        && CANVAS_DOOR_OUTCOMES.has(normalized(event?.outcome));
}

function isCanvasDecisionMakerConversation(event: any) {
    return isCanvasDoorOutcome(event)
        && CANVAS_DECISION_MAKER_OUTCOMES.has(normalized(event?.outcome));
}

function isCommittedCanvasEvent(event: any) {
    return normalized(event?.write_status) === 'committed';
}

function stripeResourceId(resource: any) {
    if (!resource) return null;
    return typeof resource === 'string' ? resource : resource.id || null;
}

function dayKey(value: number) {
    return new Date(value).toISOString().slice(0, 10);
}

function validTimeZone(value: any) {
    const timeZone = String(value || 'UTC').trim() || 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
        return timeZone;
    } catch {
        return null;
    }
}

function createDayFormatter(timeZone: string) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
}

function timeZoneDayKey(value: any, formatter: Intl.DateTimeFormat) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = formatter.formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return byType.year && byType.month && byType.day
        ? `${byType.year}-${byType.month}-${byType.day}`
        : null;
}

async function listAllEntityRecords(entity: any, label: string, sort = '-created_date') {
    const records: any[] = [];
    const seen = new Set<string>();

    for (let skip = 0; skip < MAX_ENTITY_RECORDS; skip += ENTITY_PAGE_SIZE) {
        const response = typeof entity.list === 'function'
            ? await entity.list(sort, ENTITY_PAGE_SIZE, skip)
            : await entity.filter({}, sort, ENTITY_PAGE_SIZE, skip);
        const page = asArray(response);
        let added = 0;

        for (const record of page) {
            const id = String(record?.id || '');
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            records.push(record);
            added += 1;
        }

        if (page.length < ENTITY_PAGE_SIZE) return records;
        if (added === 0) throw new Error(`${label} pagination did not advance.`);
    }

    throw new Error(`${label} exceeds the supported ${MAX_ENTITY_RECORDS.toLocaleString()}-record analytics window.`);
}

async function listAllStripeRecords(fetchPage: (startingAfter?: string) => Promise<any>, label: string, maxRecords: number) {
    const records: any[] = [];
    let startingAfter: string | undefined;

    while (records.length < maxRecords) {
        const page = await fetchPage(startingAfter);
        const items = asArray(page?.data);
        records.push(...items);
        if (!page?.has_more) return records;
        const next = items[items.length - 1]?.id;
        if (!next || next === startingAfter) throw new Error(`${label} pagination did not advance.`);
        startingAfter = next;
    }

    throw new Error(`${label} exceeds the supported analytics window.`);
}

function displayName(user: any, member: any, email: string, fallback = 'Unknown rep') {
    return String(
        user?.full_name
        || user?.name
        || member?.name
        || (email ? email.split('@')[0].replace(/[._-]+/g, ' ') : '')
        || fallback
    ).trim();
}

function activeBetaGrants(users: any[], now: number) {
    const encoded = Deno.env.get('BETA_ACCESS_GRANTS');
    if (!encoded) return [];

    try {
        const document = JSON.parse(encoded);
        if (!document || Array.isArray(document) || document.version !== 1
            || !document.grants || Array.isArray(document.grants) || typeof document.grants !== 'object') return [];

        const usersById = new Map(users.filter((user) => user?.id).map((user) => [String(user.id), user]));
        return Object.entries(document.grants).flatMap(([userId, candidate]: [string, any]) => {
            const startsAt = isoInstant(candidate?.starts_at);
            const endsAt = isoInstant(candidate?.ends_at);
            const precisionLimit = Number(candidate?.precision_limit);
            const canvasSeats = Number(candidate?.canvas_seats);
            const user = usersById.get(userId);
            const valid = candidate && !Array.isArray(candidate) && typeof candidate === 'object'
                && typeof candidate.grant_id === 'string' && candidate.grant_id.trim() === candidate.grant_id && candidate.grant_id.length > 0 && candidate.grant_id.length <= 256
                && candidate.status === 'active'
                && startsAt !== null && endsAt !== null && startsAt < endsAt
                && now >= startsAt && now < endsAt
                && typeof candidate.precision_limit === 'number' && typeof candidate.canvas_seats === 'number'
                && Number.isSafeInteger(precisionLimit) && precisionLimit >= 1 && precisionLimit <= 1000
                && Number.isSafeInteger(canvasSeats) && canvasSeats >= 1 && canvasSeats <= 100
                && Boolean(user);
            if (!valid) return [];

            return [{
                user_id: userId,
                grant_id: candidate.grant_id,
                starts_at: new Date(startsAt).toISOString(),
                ends_at: new Date(endsAt).toISOString(),
                precision_limit: precisionLimit,
                canvas_seats: canvasSeats,
                user
            }];
        });
    } catch {
        return [];
    }
}

function buildIdentityMaps(users: any[], members: any[]) {
    const userById = new Map<string, any>();
    const userByEmail = new Map<string, any>();
    const memberById = new Map<string, any>();
    const memberByUserId = new Map<string, any>();
    const memberByEmail = new Map<string, any>();
    const memberByManagerEmail = new Map<string, any>();

    for (const user of users) {
        if (user?.id) userById.set(String(user.id), user);
        const email = normalized(user?.email);
        if (email && !userByEmail.has(email)) userByEmail.set(email, user);
    }
    for (const member of members) {
        if (member?.id) memberById.set(String(member.id), member);
        if (member?.user_id && !memberByUserId.has(String(member.user_id))) {
            memberByUserId.set(String(member.user_id), member);
        }
        const email = normalized(member?.email);
        if (email && !memberByEmail.has(email)) memberByEmail.set(email, member);
        if (email && member?.manager_id) memberByManagerEmail.set(`${String(member.manager_id)}:${email}`, member);
    }

    return { userById, userByEmail, memberById, memberByUserId, memberByEmail, memberByManagerEmail };
}

function precisionIdentity(log: any, maps: any) {
    const email = normalized(log?.created_by);
    const loggedByUserId = String(log?.logged_by_user_id || '');
    const repId = String(log?.rep_id || '');
    const repMember = maps.memberById.get(repId);
    const user = maps.userById.get(loggedByUserId)
        || maps.userById.get(repId)
        || maps.userById.get(String(repMember?.user_id || ''))
        || maps.userByEmail.get(email);
    const member = repMember
        || maps.memberByUserId.get(String(user?.id || loggedByUserId || repId))
        || maps.memberByManagerEmail.get(`${String(log?.manager_id || '')}:${email}`)
        || maps.memberByEmail.get(email);
    const userId = String(user?.id || loggedByUserId || member?.user_id || '');
    const manager = maps.userById.get(String(log?.manager_id || member?.manager_id || ''));
    return {
        key: userId ? `user:${userId}` : `email:${email || 'unknown'}`,
        name: displayName(user, member, email),
        email: email || 'Email unavailable',
        team_name: displayName(manager, null, normalized(manager?.email), 'Independent'),
        source: 'precision'
    };
}

function canvasIdentity(record: any, maps: any) {
    const actorUserId = String(record?.actor_user_id || record?.last_actor_user_id || '');
    const memberId = String(record?.actor_team_member_id || record?.last_actor_team_member_id || '');
    const user = maps.userById.get(actorUserId);
    const member = maps.memberById.get(memberId);
    const email = normalized(user?.email || member?.email);
    const userId = actorUserId || String(member?.user_id || '');
    const manager = maps.userById.get(String(record?.manager_id || member?.manager_id || ''));
    return {
        key: userId ? `user:${userId}` : memberId ? `member:${memberId}` : `email:${email || 'unknown'}`,
        name: displayName(user, member, email),
        email: email || 'Email unavailable',
        team_name: displayName(manager, null, normalized(manager?.email), 'Independent'),
        source: 'canvas'
    };
}

function teamMemberIdentity(member: any, maps: any) {
    const memberEmail = normalized(member?.email);
    const user = maps.userById.get(String(member?.user_id || '')) || maps.userByEmail.get(memberEmail);
    const email = normalized(user?.email || memberEmail);
    const userId = String(user?.id || member?.user_id || '');
    const manager = maps.userById.get(String(member?.manager_id || ''));
    return {
        key: userId ? `user:${userId}` : `member:${String(member?.id || email || 'unknown')}`,
        name: displayName(user, member, email),
        email: email || 'Email unavailable',
        team_name: displayName(manager, null, normalized(manager?.email), 'Independent'),
        source: 'roster'
    };
}

function userIdentity(user: any, maps: any) {
    const email = normalized(user?.email);
    const userId = String(user?.id || '');
    const member = maps.memberByUserId.get(userId) || maps.memberByEmail.get(email);
    const manager = maps.userById.get(String(member?.manager_id || ''));
    return {
        key: userId ? `user:${userId}` : `email:${email || 'unknown'}`,
        name: displayName(user, member, email),
        email: email || 'Email unavailable',
        team_name: displayName(manager, null, normalized(manager?.email), 'Independent'),
        source: 'account'
    };
}

function withinPeriod(recordTime: number | null, days: number | null, now: number) {
    if (days === null) return true;
    return recordTime !== null && recordTime >= now - days * DAY_MS;
}

function createRepAggregate(identity: any) {
    return {
        key: identity.key,
        name: identity.name,
        email: identity.email,
        team_name: identity.team_name,
        knocks: 0,
        decision_maker_conversations: 0,
        confirmed_sales: 0,
        recorded_sales_volume: 0,
        valued_sales: 0,
        appointments: 0,
        callbacks: 0,
        last_activity_at: null as string | null,
        precision_knocks: 0,
        canvas_knocks: 0
    };
}

function updateRepAggregate(
    rep: any,
    identity: any,
    outcome: string,
    amount: number,
    occurredAt: number | null,
    isDecisionMakerConversation: boolean
) {
    rep.knocks += 1;
    if (isDecisionMakerConversation) rep.decision_maker_conversations += 1;
    if (identity.source === 'canvas') rep.canvas_knocks += 1;
    else rep.precision_knocks += 1;
    if (outcome === 'sale') {
        rep.confirmed_sales += 1;
        rep.recorded_sales_volume += amount;
        if (amount > 0) rep.valued_sales += 1;
    }
    if (outcome === 'appointment') rep.appointments += 1;
    if (outcome === 'callback') rep.callbacks += 1;
    if (occurredAt !== null && (!rep.last_activity_at || occurredAt > Date.parse(rep.last_activity_at))) {
        rep.last_activity_at = new Date(occurredAt).toISOString();
    }
}

function buildRepPeriod(
    interactionLogs: any[],
    canvasEvents: any[],
    maps: any,
    days: number | null,
    now: number
) {
    const reps = new Map<string, any>();
    const doors = new Set<string>();
    let knocks = 0;
    let decisionMakerConversations = 0;
    let confirmedSales = 0;
    let recordedSalesVolume = 0;
    let valuedSales = 0;
    let appointments = 0;
    let callbacks = 0;
    let noAnswers = 0;
    let precisionKnocks = 0;
    let canvasKnocks = 0;

    for (const log of interactionLogs) {
        const occurredAt = timestamp(log?.created_date || log?.updated_date);
        if (!withinPeriod(occurredAt, days, now)) continue;
        if (!isPrecisionDoorOutcome(log)) continue;
        const status = normalized(log?.parsed_status);
        const outcome = status === 'sold' ? 'sale' : status === 'callback' ? 'callback' : status;
        const amount = outcome === 'sale' ? finiteNonNegative(log?.sale_amount) : 0;
        const identity = precisionIdentity(log, maps);
        const rep = reps.get(identity.key) || createRepAggregate(identity);
        const decisionMakerConversation = isPrecisionDecisionMakerConversation(log);

        knocks += 1;
        if (decisionMakerConversation) decisionMakerConversations += 1;
        precisionKnocks += 1;
        if (log?.address_hash) doors.add(`precision:${log.address_hash}`);
        if (outcome === 'sale') {
            confirmedSales += 1;
            recordedSalesVolume += amount;
            if (amount > 0) valuedSales += 1;
        }
        if (outcome === 'callback') callbacks += 1;
        if (status === 'no_answer' || status === 'dm_not_home') noAnswers += 1;
        updateRepAggregate(rep, identity, outcome, amount, occurredAt, decisionMakerConversation);
        reps.set(identity.key, rep);
    }

    for (const event of canvasEvents) {
        if (!isCanvasDoorOutcome(event)) continue;
        const occurredAt = timestamp(event?.client_recorded_at || event?.server_recorded_at || event?.created_date);
        if (!withinPeriod(occurredAt, days, now)) continue;
        const outcome = normalized(event?.outcome);
        const identity = canvasIdentity(event, maps);
        const rep = reps.get(identity.key) || createRepAggregate(identity);
        const decisionMakerConversation = isCanvasDecisionMakerConversation(event);

        knocks += 1;
        if (decisionMakerConversation) decisionMakerConversations += 1;
        canvasKnocks += 1;
        if (event?.pin_id) doors.add(`canvas:${event.pin_id}`);
        if (outcome === 'sale') confirmedSales += 1;
        if (outcome === 'appointment') appointments += 1;
        if (outcome === 'callback') callbacks += 1;
        if (outcome === 'no_answer') noAnswers += 1;
        updateRepAggregate(rep, identity, outcome, 0, occurredAt, decisionMakerConversation);
        reps.set(identity.key, rep);
    }

    const leaderboard = [...reps.values()]
        .filter((rep) => !HIDDEN_PLATFORM_ANALYTICS_REP_NAMES.has(normalizedLeaderboardName(rep?.name)))
        .map((rep) => ({
            ...rep,
            close_rate: closeRate(rep.confirmed_sales, rep.knocks),
            door_close_rate: closeRate(rep.confirmed_sales, rep.knocks),
            decision_maker_contacts: rep.decision_maker_conversations,
            talk_rate: closeRate(rep.decision_maker_conversations, rep.knocks),
            contact_rate: closeRate(rep.decision_maker_conversations, rep.knocks),
            decision_maker_close_rate: closeRate(rep.confirmed_sales, rep.decision_maker_conversations),
            unvalued_sales: Math.max(0, rep.confirmed_sales - rep.valued_sales)
        }))
        .sort((left, right) => (
            right.confirmed_sales - left.confirmed_sales
            || right.decision_maker_close_rate - left.decision_maker_close_rate
            || right.close_rate - left.close_rate
            || right.recorded_sales_volume - left.recorded_sales_volume
            || right.knocks - left.knocks
        ))
        .slice(0, 250);

    return {
        knocks,
        unique_doors: doors.size,
        decision_maker_conversations: decisionMakerConversations,
        decision_maker_contacts: decisionMakerConversations,
        confirmed_sales: confirmedSales,
        close_rate: closeRate(confirmedSales, knocks),
        door_close_rate: closeRate(confirmedSales, knocks),
        talk_rate: closeRate(decisionMakerConversations, knocks),
        contact_rate: closeRate(decisionMakerConversations, knocks),
        decision_maker_close_rate: closeRate(confirmedSales, decisionMakerConversations),
        recorded_sales_volume: round(recordedSalesVolume, 2),
        valued_sales: valuedSales,
        unvalued_sales: Math.max(0, confirmedSales - valuedSales),
        active_reps: reps.size,
        appointments,
        callbacks,
        no_answers: noAnswers,
        precision_knocks: precisionKnocks,
        canvas_knocks: canvasKnocks,
        leaderboard
    };
}

function buildRepTrend(interactionLogs: any[], canvasEvents: any[], now: number, days = 30) {
    const buckets = new Map<string, any>();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);

    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(start.getTime() - offset * DAY_MS);
        const key = date.toISOString().slice(0, 10);
        buckets.set(key, {
            date: key,
            label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
            knocks: 0,
            decision_maker_conversations: 0,
            sales: 0,
            rep_revenue: 0,
            stripe_revenue: 0
        });
    }

    for (const log of interactionLogs) {
        const occurredAt = timestamp(log?.created_date || log?.updated_date);
        if (occurredAt === null) continue;
        const bucket = buckets.get(dayKey(occurredAt));
        if (!bucket) continue;
        if (!isPrecisionDoorOutcome(log)) continue;
        bucket.knocks += 1;
        if (isPrecisionDecisionMakerConversation(log)) bucket.decision_maker_conversations += 1;
        if (normalized(log?.parsed_status) === 'sold') {
            bucket.sales += 1;
            bucket.rep_revenue += finiteNonNegative(log?.sale_amount);
        }
    }

    for (const event of canvasEvents) {
        if (!isCanvasDoorOutcome(event)) continue;
        const occurredAt = timestamp(event?.client_recorded_at || event?.server_recorded_at || event?.created_date);
        if (occurredAt === null) continue;
        const bucket = buckets.get(dayKey(occurredAt));
        if (!bucket) continue;
        bucket.knocks += 1;
        if (isCanvasDecisionMakerConversation(event)) bucket.decision_maker_conversations += 1;
        if (normalized(event?.outcome) === 'sale') bucket.sales += 1;
    }

    return [...buckets.values()].map((bucket) => ({
        ...bucket,
        rep_revenue: round(bucket.rep_revenue, 2)
    }));
}

function buildAdoptionWindowDays(now: number, windowDays: number, formatter: Intl.DateTimeFormat) {
    const currentDateKey = timeZoneDayKey(now, formatter) || dayKey(now);
    const currentDate = new Date(`${currentDateKey}T12:00:00.000Z`);
    const days: any[] = [];

    for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
        const date = new Date(currentDate.getTime() - offset * DAY_MS);
        const key = date.toISOString().slice(0, 10);
        const isoDow = date.getUTCDay(); // 0=Sunday..6=Saturday
        days.push({
            date: key,
            label: date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
            weekday: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
            dow: (isoDow + 6) % 7 // 0=Monday..6=Sunday
        });
    }

    return days;
}

function buildAdoptionActivity(
    interactionLogs: any[],
    canvasEvents: any[],
    maps: any,
    teamMembers: any[],
    users: any[],
    now: number,
    timeZone: string,
    windowDays = ADOPTION_WINDOW_DAYS
) {
    const dayFormatter = createDayFormatter(timeZone);
    const days = buildAdoptionWindowDays(now, windowDays, dayFormatter);
    const includedDays = new Set(days.map((day) => day.date));
    const reps = new Map<string, any>();

    const ensureRep = (identity: any) => {
        if (!identity?.key || identity.key === 'email:unknown') return null;
        const existing = reps.get(identity.key);
        if (existing) return existing;
        const created = { key: identity.key, name: identity.name, email: identity.email, team_name: identity.team_name, days: new Map<string, any>(), total_logs: 0, last_activity_at: null as string | null };
        reps.set(identity.key, created);
        return created;
    };

    const touch = (identity: any, date: string, occurredAt: number | null, metrics: any) => {
        const rep = ensureRep(identity);
        if (!rep) return;
        const bucket = rep.days.get(date) || {
            logs: 0,
            doors: 0,
            sales: 0,
            recorded_sales_volume: 0,
            callbacks: 0,
            knock_logs: 0,
            canvas_logs: 0,
            last_activity_at: null
        };
        bucket.logs += 1;
        bucket.doors += metrics.doors || 0;
        bucket.sales += metrics.sales || 0;
        bucket.recorded_sales_volume = round(
            bucket.recorded_sales_volume + finiteNonNegative(metrics.recorded_sales_volume),
            2
        );
        bucket.callbacks += metrics.callbacks || 0;
        bucket.knock_logs += metrics.knock_logs || 0;
        bucket.canvas_logs += metrics.canvas_logs || 0;
        if (occurredAt !== null && (!bucket.last_activity_at || occurredAt > Date.parse(bucket.last_activity_at))) {
            bucket.last_activity_at = new Date(occurredAt).toISOString();
        }
        rep.days.set(date, bucket);
        rep.total_logs += 1;
        if (occurredAt !== null && (!rep.last_activity_at || occurredAt > Date.parse(rep.last_activity_at))) {
            rep.last_activity_at = new Date(occurredAt).toISOString();
        }
    };

    for (const log of interactionLogs) {
        if (normalized(log?.source) === 'csv_history_import') continue;
        const occurredAt = timestamp(log?.created_date || log?.updated_date);
        const date = occurredAt === null ? null : timeZoneDayKey(occurredAt, dayFormatter);
        if (occurredAt === null || !date || !includedDays.has(date)) continue;
        const identity = precisionIdentity(log, maps);
        const status = normalized(log?.parsed_status);
        touch(identity, date, occurredAt, {
            doors: isPrecisionDoorOutcome(log) ? 1 : 0,
            sales: status === 'sold' ? 1 : 0,
            recorded_sales_volume: status === 'sold' ? finiteNonNegative(log?.sale_amount) : 0,
            callbacks: status === 'callback' ? 1 : 0,
            knock_logs: 1,
            canvas_logs: 0
        });
    }

    for (const event of canvasEvents) {
        if (!isCommittedCanvasEvent(event)) continue;
        const occurredAt = timestamp(event?.client_recorded_at || event?.server_recorded_at || event?.created_date);
        const date = occurredAt === null ? null : timeZoneDayKey(occurredAt, dayFormatter);
        if (occurredAt === null || !date || !includedDays.has(date)) continue;
        const identity = canvasIdentity(event, maps);
        const outcome = normalized(event?.outcome);
        touch(identity, date, occurredAt, {
            doors: isCanvasDoorOutcome(event) ? 1 : 0,
            sales: outcome === 'sale' ? 1 : 0,
            recorded_sales_volume: 0,
            callbacks: outcome === 'callback' ? 1 : 0,
            knock_logs: 0,
            canvas_logs: 1
        });
    }

    for (const member of teamMembers) {
        ensureRep(teamMemberIdentity(member, maps));
    }
    for (const user of users) {
        ensureRep(userIdentity(user, maps));
    }

    const repList = [...reps.values()]
        .filter((rep) => !HIDDEN_PLATFORM_ANALYTICS_REP_NAMES.has(normalizedLeaderboardName(rep?.name)))
        .map((rep) => ({
            key: rep.key,
            name: rep.name,
            email: rep.email,
            team_name: rep.team_name,
            total_logs: rep.total_logs,
            last_activity_at: rep.last_activity_at,
            active_days_in_window: rep.days.size,
            days: Object.fromEntries(rep.days)
        }))
        .sort((left, right) => (
            right.active_days_in_window - left.active_days_in_window
            || right.total_logs - left.total_logs
            || left.name.localeCompare(right.name)
        ));

    return {
        generated_at: new Date(now).toISOString(),
        window_days: windowDays,
        time_zone: timeZone,
        days,
        reps: repList
    };
}

function countCurrentSoldDoors(interactionLogs: any[], canvasPins: any[]) {
    const latestPrecisionByDoor = new Map<string, any>();
    for (const log of interactionLogs) {
        if (!log?.address_hash) continue;
        const key = `${String(log?.manager_id || 'unscoped')}:${String(log.address_hash)}`;
        const current = latestPrecisionByDoor.get(key);
        const currentTime = timestamp(current?.created_date || current?.updated_date) || 0;
        const nextTime = timestamp(log?.created_date || log?.updated_date) || 0;
        if (!current || nextTime >= currentTime) latestPrecisionByDoor.set(key, log);
    }
    const precision = [...latestPrecisionByDoor.values()].filter((log) => normalized(log?.parsed_status) === 'sold').length;
    const canvas = canvasPins.filter((pin) => normalized(pin?.latest_outcome) === 'sale').length;
    return { total: precision + canvas, precision, canvas };
}

function monthlyRecurringCents(subscription: any) {
    return (subscription?.items?.data || []).reduce((total: number, item: any) => {
        const recurring = item?.price?.recurring;
        const intervalCount = Math.max(1, Number(recurring?.interval_count || 1));
        const unitAmount = finiteNonNegative(item?.price?.unit_amount ?? item?.price?.unit_amount_decimal);
        const quantity = Math.max(1, Number(item?.quantity || 1));
        let monthlyMultiplier = 0;
        if (recurring?.interval === 'month') monthlyMultiplier = 1 / intervalCount;
        if (recurring?.interval === 'year') monthlyMultiplier = 1 / (12 * intervalCount);
        if (recurring?.interval === 'week') monthlyMultiplier = 52 / (12 * intervalCount);
        if (recurring?.interval === 'day') monthlyMultiplier = 365 / (12 * intervalCount);
        return total + unitAmount * quantity * monthlyMultiplier;
    }, 0);
}

function subscriptionSeats(subscription: any) {
    return (subscription?.items?.data || []).reduce(
        (sum: number, item: any) => sum + Math.max(1, Number(item?.quantity || 1)),
        0
    );
}

function subscriptionPlan(subscription: any) {
    const metadataTier = normalized(subscription?.metadata?.subscription_tier);
    if (metadataTier) return metadataTier === 'precision' ? 'Precision' : metadataTier === 'canvas' ? 'Canvas' : metadataTier;
    const item = subscription?.items?.data?.[0];
    const amount = Number(item?.price?.unit_amount || 0);
    if (amount === 9900) return 'Precision';
    if (amount === 1900) return 'Canvas';
    const nickname = String(item?.price?.nickname || item?.plan?.nickname || '').trim();
    return nickname || 'Custom';
}

async function loadStripeLiveData() {
    const secretKey = Deno.env.get('STRIPE_SECRET_KEY') || '';
    if (!secretKey) {
        return { status: 'unavailable', message: 'Stripe is not configured for the deployed environment.' };
    }

    const stripe = new Stripe(secretKey);
    try {
        const [customers, subscriptions, invoices, eventsPage] = await Promise.all([
            listAllStripeRecords(
                (startingAfter) => stripe.customers.list({
                    limit: 100,
                    ...(startingAfter ? { starting_after: startingAfter } : {})
                }),
                'Stripe customers',
                MAX_STRIPE_CUSTOMERS
            ),
            listAllStripeRecords(
                (startingAfter) => stripe.subscriptions.list({
                    status: 'all',
                    limit: 100,
                    ...(startingAfter ? { starting_after: startingAfter } : {}),
                    expand: ['data.customer', 'data.latest_invoice']
                }),
                'Stripe subscriptions',
                MAX_STRIPE_SUBSCRIPTIONS
            ),
            listAllStripeRecords(
                (startingAfter) => stripe.invoices.list({
                    status: 'paid',
                    limit: 100,
                    ...(startingAfter ? { starting_after: startingAfter } : {})
                }),
                'Stripe paid invoices',
                MAX_STRIPE_INVOICES
            ),
            stripe.events.list({ limit: 100 })
        ]);

        return {
            status: 'live',
            customers,
            subscriptions,
            invoices,
            events: asArray(eventsPage?.data),
            livemode: Boolean(
                asArray(eventsPage?.data)[0]?.livemode
                ?? subscriptions[0]?.livemode
                ?? invoices[0]?.livemode
                ?? customers[0]?.livemode
            )
        };
    } catch (error: any) {
        console.error('[adminDiagnostics] Stripe read failed:', error?.message || error);
        return { status: 'error', message: 'Stripe could not be reached. App analytics are still live.' };
    }
}

function invoicePaidAt(invoice: any) {
    return stripeTimestamp(invoice?.status_transitions?.paid_at) || stripeTimestamp(invoice?.created);
}

function invoiceBelongsToSubscription(invoice: any, subscription: any) {
    const subscriptionId = String(subscription?.id || '');
    if (!subscriptionId) return false;
    const directId = String(
        stripeResourceId(invoice?.subscription)
        || stripeResourceId(invoice?.parent?.subscription_details?.subscription)
        || ''
    );
    if (directId) return directId === subscriptionId;
    return (invoice?.lines?.data || []).some((line: any) => String(
        stripeResourceId(line?.subscription)
        || stripeResourceId(line?.parent?.subscription_item_details?.subscription)
        || ''
    ) === subscriptionId);
}

function indexInvoicesBySubscription(invoices: any[]) {
    const indexed = new Map<string, any[]>();
    for (const invoice of invoices) {
        const ids = new Set<string>();
        const directId = String(
            stripeResourceId(invoice?.subscription)
            || stripeResourceId(invoice?.parent?.subscription_details?.subscription)
            || ''
        );
        if (directId) ids.add(directId);
        for (const line of invoice?.lines?.data || []) {
            const lineId = String(
                stripeResourceId(line?.subscription)
                || stripeResourceId(line?.parent?.subscription_item_details?.subscription)
                || ''
            );
            if (lineId) ids.add(lineId);
        }
        for (const subscriptionId of ids) {
            const rows = indexed.get(subscriptionId) || [];
            rows.push(invoice);
            indexed.set(subscriptionId, rows);
        }
    }
    return indexed;
}

function invoiceCoversSubscriptionPeriod(invoice: any, subscription: any) {
    const subscriptionId = String(subscription?.id || '');
    if (!subscriptionId || !invoiceBelongsToSubscription(invoice, subscription)) return false;
    const currentStart = Number(subscription?.current_period_start);
    if (!Number.isFinite(currentStart) || currentStart <= 0) return false;

    const matchingLine = (invoice?.lines?.data || []).some((line: any) => {
        const lineSubscriptionId = String(stripeResourceId(line?.subscription) || subscriptionId);
        const start = Number(line?.period?.start);
        const end = Number(line?.period?.end);
        return lineSubscriptionId === subscriptionId
            && Number.isFinite(start)
            && Number.isFinite(end)
            && start <= currentStart
            && currentStart < end;
    });
    if (matchingLine) return true;

    const invoiceStart = Number(invoice?.period_start);
    const invoiceEnd = Number(invoice?.period_end);
    return Number.isFinite(invoiceStart)
        && Number.isFinite(invoiceEnd)
        && invoiceStart <= currentStart
        && currentStart < invoiceEnd;
}

function eventCustomerEmail(object: any, customerById: Map<string, any>, userById: Map<string, any>) {
    const customerId = stripeResourceId(object?.customer);
    const subscriptionUserId = String(object?.metadata?.base44_user_id || '');
    return normalized(
        object?.customer_email
        || object?.customer_details?.email
        || object?.receipt_email
        || customerById.get(String(customerId || ''))?.email
        || userById.get(subscriptionUserId)?.email
    );
}

function buildStripeFeed(events: any[], customerById: Map<string, any>, userById: Map<string, any>) {
    const supported = new Set([
        'invoice.paid',
        'invoice.payment_failed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'customer.subscription.trial_will_end',
        'charge.refunded'
    ]);

    return events.flatMap((event) => {
        if (!supported.has(event?.type)) return [];
        const object = event?.data?.object || {};
        if (event.type === 'customer.subscription.updated' && !event?.data?.previous_attributes?.status) return [];
        const occurredAt = stripeTimestamp(event?.created);
        const email = eventCustomerEmail(object, customerById, userById) || 'Customer email unavailable';
        const status = normalized(object?.status);
        let category = 'subscription';
        let title = 'Subscription updated';
        let amountCents = 0;

        if (event.type === 'invoice.paid') {
            category = 'payment';
            title = 'Payment confirmed';
            amountCents = finiteNonNegative(object?.amount_paid);
        } else if (event.type === 'invoice.payment_failed') {
            category = 'failed';
            title = 'Payment failed';
            amountCents = finiteNonNegative(object?.amount_due);
        } else if (event.type === 'customer.subscription.created' && status === 'trialing') {
            category = 'trial';
            title = 'Trial started';
        } else if (event.type === 'customer.subscription.created') {
            category = 'customer';
            title = 'Subscription started';
        } else if (event.type === 'customer.subscription.trial_will_end') {
            category = 'trial';
            title = 'Trial ending soon';
        } else if (event.type === 'customer.subscription.deleted') {
            category = 'canceled';
            title = 'Subscription canceled';
        } else if (event.type === 'customer.subscription.updated') {
            category = status === 'trialing' ? 'trial' : status === 'active' ? 'customer' : 'subscription';
            title = `Subscription ${status || 'updated'}`;
        } else if (event.type === 'charge.refunded') {
            category = 'refund';
            title = 'Payment refunded';
            amountCents = finiteNonNegative(object?.amount_refunded);
        }

        return [{
            id: `stripe:${event.id}`,
            source: 'stripe',
            category,
            title,
            email,
            amount: round(amountCents / 100, 2),
            currency: normalized(object?.currency) || 'usd',
            occurred_at: occurredAt ? new Date(occurredAt).toISOString() : null
        }];
    });
}

function buildStripeAnalytics(stripeData: any, users: any[], trend: any[], betaGrants: any[] = []) {
    if (stripeData?.status !== 'live') {
        return {
            source: { status: stripeData?.status || 'unavailable', message: stripeData?.message || 'Stripe is unavailable.' },
            metrics: null,
            customer_count: 0,
            customers_truncated: false,
            customers: [],
            plan_mix: [],
            feed: [],
            trend
        };
    }

    const userById = new Map(users.filter((user) => user?.id).map((user) => [String(user.id), user]));
    const userByEmail = new Map(users.filter((user) => user?.email).map((user) => [normalized(user.email), user]));
    const subscriptions = stripeData.subscriptions || [];
    const paidInvoices = (stripeData.invoices || []).filter((invoice: any) => finiteNonNegative(invoice?.amount_paid) > 0);
    const paidInvoicesBySubscription = indexInvoicesBySubscription(paidInvoices);
    const customerById = new Map<string, any>();

    for (const customer of stripeData.customers || []) {
        if (customer?.id && !customer?.deleted) customerById.set(String(customer.id), customer);
    }

    for (const subscription of subscriptions) {
        const customer = typeof subscription?.customer === 'object' ? subscription.customer : null;
        if (customer?.id) customerById.set(String(customer.id), customer);
    }

    const rows = subscriptions.map((subscription: any) => {
        const customerId = String(stripeResourceId(subscription?.customer) || '');
        const customer = customerById.get(customerId);
        const metadataUserId = String(subscription?.metadata?.base44_user_id || '');
        const metadataUser = userById.get(metadataUserId);
        const customerEmail = normalized(customer?.email || metadataUser?.email);
        const matchedUser = metadataUser || userByEmail.get(customerEmail);
        const status = normalized(subscription?.status) || 'unknown';
        const mrrCents = monthlyRecurringCents(subscription);
        const subscriptionInvoices = paidInvoicesBySubscription.get(String(subscription?.id || '')) || [];
        const hasPaidHistory = subscriptionInvoices.length > 0;
        const currentPeriodPaid = subscriptionInvoices.some((invoice: any) => invoiceCoversSubscriptionPeriod(invoice, subscription));
        const confirmedPaid = status === 'active' && mrrCents > 0 && hasPaidHistory;
        const createdAt = stripeTimestamp(subscription?.created);
        const currentPeriodEnd = stripeTimestamp(subscription?.current_period_end);
        const trialEnd = stripeTimestamp(subscription?.trial_end);

        return {
            key: `subscription:${subscription.id}`,
            name: String(customer?.name || matchedUser?.full_name || matchedUser?.name || '').trim() || (customerEmail ? customerEmail.split('@')[0] : 'FirstKnock customer'),
            email: customerEmail || 'Customer email unavailable',
            plan: subscriptionPlan(subscription),
            status,
            seats: subscriptionSeats(subscription),
            mrr: round(mrrCents / 100, 2),
            paid_confirmed: confirmedPaid,
            paid_history_confirmed: hasPaidHistory,
            current_period_paid: status === 'active' && currentPeriodPaid,
            started_at: createdAt ? new Date(createdAt).toISOString() : null,
            renews_at: currentPeriodEnd ? new Date(currentPeriodEnd).toISOString() : null,
            trial_ends_at: trialEnd ? new Date(trialEnd).toISOString() : null,
            customer_key: customerId || metadataUserId || customerEmail || String(subscription.id),
            matched_user_id: String(matchedUser?.id || metadataUserId || ''),
            billing_source: 'stripe'
        };
    });

    const currentStripeRows = rows.filter((row: any) => (
        row.paid_confirmed
        || row.status === 'trialing'
        || row.status === 'past_due' && row.paid_history_confirmed
    ));
    const currentStripeUserIds = new Set(currentStripeRows.map((row: any) => row.matched_user_id).filter(Boolean));
    const currentStripeEmails = new Set(currentStripeRows.map((row: any) => normalized(row.email)).filter(Boolean));
    const betaRows = betaGrants.flatMap((grant: any) => {
        const user = grant?.user;
        const userId = String(grant?.user_id || user?.id || '');
        const email = normalized(user?.email);
        if (!userId || currentStripeUserIds.has(userId) || (email && currentStripeEmails.has(email))) return [];
        const tier = normalized(user?.subscription_tier);
        const planName = tier ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)} beta` : 'FirstKnock beta';
        return [{
            key: `beta:${userId}`,
            name: displayName(user, null, email, 'FirstKnock beta account'),
            email: email || 'Email unavailable',
            plan: planName,
            status: 'beta',
            seats: grant.canvas_seats,
            mrr: 0,
            paid_confirmed: false,
            paid_history_confirmed: false,
            current_period_paid: false,
            started_at: grant.starts_at,
            renews_at: null,
            trial_ends_at: grant.ends_at,
            customer_key: `beta:${userId}`,
            matched_user_id: userId,
            billing_source: 'firstknock_beta'
        }];
    });
    const customerRows = [...rows, ...betaRows];
    const activePaidRows = rows.filter((row: any) => row.status === 'active' && row.paid_confirmed);
    const contractedMrrRows = rows.filter((row: any) => ['active', 'past_due'].includes(row.status) && row.paid_history_confirmed && row.mrr > 0);
    const trialRows = rows.filter((row: any) => row.status === 'trialing');
    const activePaidCustomerKeys = new Set(activePaidRows.map((row: any) => row.customer_key));
    const currentPeriodPaidCustomerKeys = new Set(rows.filter((row: any) => row.current_period_paid).map((row: any) => row.customer_key));
    const trialCustomerKeys = new Set(trialRows.map((row: any) => row.customer_key));
    const activeBetaCustomerKeys = new Set(betaRows.map((row: any) => row.customer_key));
    const listedStripeCustomerKeys = new Set((stripeData.customers || []).filter((customer: any) => customer?.id && !customer?.deleted).map((customer: any) => String(customer.id)));
    const subscriptionCustomerKeys = new Set(rows.map((row: any) => row.customer_key));
    const now = Date.now();
    const paidLast30Days = paidInvoices.filter((invoice: any) => {
        const paidAt = invoicePaidAt(invoice);
        return paidAt !== null && paidAt >= now - 30 * DAY_MS;
    });
    const paidLast7Days = paidInvoices.filter((invoice: any) => {
        const paidAt = invoicePaidAt(invoice);
        return paidAt !== null && paidAt >= now - 7 * DAY_MS;
    });
    const usdPaidInvoices = paidInvoices.filter((invoice: any) => normalized(invoice?.currency || 'usd') === 'usd');

    const trendByDay = new Map(trend.map((point: any) => [point.date, point]));
    for (const invoice of paidInvoices) {
        if (normalized(invoice?.currency || 'usd') !== 'usd') continue;
        const paidAt = invoicePaidAt(invoice);
        if (paidAt === null) continue;
        const point = trendByDay.get(dayKey(paidAt));
        if (point) point.stripe_revenue = round(point.stripe_revenue + finiteNonNegative(invoice.amount_paid) / 100, 2);
    }

    const planMap = new Map<string, any>();
    for (const row of customerRows.filter((candidate: any) => ['active', 'trialing', 'beta', 'past_due'].includes(candidate.status))) {
        const plan = planMap.get(row.plan) || { name: row.plan, subscriptions: 0, seats: 0, mrr: 0 };
        plan.subscriptions += 1;
        plan.seats += row.seats;
        if (row.paid_history_confirmed && ['active', 'past_due'].includes(row.status)) plan.mrr += row.mrr;
        planMap.set(row.plan, plan);
    }

    const statusPriority: Record<string, number> = { active: 0, trialing: 1, beta: 2, past_due: 3, unpaid: 4, incomplete: 5, canceled: 6 };
    const customers = customerRows
        .sort((left: any, right: any) => (
            (statusPriority[left.status] ?? 9) - (statusPriority[right.status] ?? 9)
            || (timestamp(right.started_at) || 0) - (timestamp(left.started_at) || 0)
        ))
        .slice(0, 500)
        .map(({ customer_key: _customerKey, matched_user_id: _matchedUserId, paid_history_confirmed: _paidHistoryConfirmed, ...row }: any) => row);

    return {
        source: {
            status: 'live',
            mode: stripeData.livemode ? 'live' : 'test',
            message: stripeData.livemode ? 'Connected to live Stripe data' : 'Connected to Stripe test data'
        },
        metrics: {
            paying_customers: activePaidCustomerKeys.size,
            current_period_paid_customers: currentPeriodPaidCustomerKeys.size,
            active_trials: trialCustomerKeys.size,
            active_beta_accounts: activeBetaCustomerKeys.size,
            active_trials_and_beta: trialCustomerKeys.size + activeBetaCustomerKeys.size,
            total_stripe_customers: listedStripeCustomerKeys.size || subscriptionCustomerKeys.size,
            mrr: round(contractedMrrRows.reduce((sum: number, row: any) => sum + row.mrr, 0), 2),
            trial_mrr_pipeline: round(trialRows.reduce((sum: number, row: any) => sum + row.mrr, 0), 2),
            gross_collected: round(usdPaidInvoices.reduce((sum: number, invoice: any) => sum + finiteNonNegative(invoice.amount_paid), 0) / 100, 2),
            collected_30d: round(paidLast30Days.filter((invoice: any) => normalized(invoice?.currency || 'usd') === 'usd').reduce((sum: number, invoice: any) => sum + finiteNonNegative(invoice.amount_paid), 0) / 100, 2),
            collected_7d: round(paidLast7Days.filter((invoice: any) => normalized(invoice?.currency || 'usd') === 'usd').reduce((sum: number, invoice: any) => sum + finiteNonNegative(invoice.amount_paid), 0) / 100, 2),
            paid_seats: activePaidRows.reduce((sum: number, row: any) => sum + row.seats, 0),
            trial_seats: trialRows.reduce((sum: number, row: any) => sum + row.seats, 0),
            beta_seats: betaRows.reduce((sum: number, row: any) => sum + row.seats, 0),
            past_due_customers: new Set(rows.filter((row: any) => ['past_due', 'unpaid'].includes(row.status)).map((row: any) => row.customer_key)).size,
            canceled_subscriptions: rows.filter((row: any) => row.status === 'canceled').length,
            confirmed_payments: paidInvoices.length,
            non_usd_payments_excluded: paidInvoices.length - usdPaidInvoices.length
        },
        customer_count: customerRows.length,
        customers_truncated: customerRows.length > customers.length,
        customers,
        plan_mix: [...planMap.values()].map((plan) => ({ ...plan, mrr: round(plan.mrr, 2) })).sort((left, right) => right.mrr - left.mrr),
        feed: buildStripeFeed(stripeData.events || [], customerById, userById),
        trend
    };
}

function buildRecentRepSales(interactionLogs: any[], canvasEvents: any[], maps: any) {
    const precision = interactionLogs
        .filter((log) => normalized(log?.parsed_status) === 'sold')
        .map((log) => {
            const identity = precisionIdentity(log, maps);
            return {
                id: `sale:${log.id}`,
                source: 'firstknock',
                category: 'sale',
                title: 'Rep sale confirmed',
                email: identity.email,
                name: identity.name,
                amount: round(finiteNonNegative(log?.sale_amount), 2),
                currency: 'usd',
                occurred_at: log?.created_date || log?.updated_date || null,
                mode: 'Precision'
            };
        });
    const canvas = canvasEvents
        .filter((event) => normalized(event?.write_status) === 'committed' && normalized(event?.outcome) === 'sale')
        .map((event) => {
            const identity = canvasIdentity(event, maps);
            return {
                id: `canvas-sale:${event.id}`,
                source: 'firstknock',
                category: 'sale',
                title: 'Rep sale confirmed',
                email: identity.email,
                name: identity.name,
                amount: 0,
                currency: 'usd',
                occurred_at: event?.client_recorded_at || event?.server_recorded_at || event?.created_date || null,
                mode: 'Canvas'
            };
        });

    return [...precision, ...canvas]
        .sort((left, right) => (timestamp(right.occurred_at) || 0) - (timestamp(left.occurred_at) || 0))
        .slice(0, 50);
}

async function runLegacyAdminDiagnostics(base44: any, user: any, body: any) {
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

    const sql = neon(databaseUrl);
    const targetEmail = body.user_email || user.email;
    const propertyStats = await sql`
        SELECT
            COUNT(*)::int AS global_properties,
            COUNT(*) FILTER (WHERE sold_date >= NOW() - INTERVAL '30 days')::int AS sold_last_30_days,
            COUNT(*) FILTER (WHERE sale_type = 'MLS')::int AS mls_properties,
            COUNT(*) FILTER (WHERE original_status = 'REJECTED' OR sale_confidence = 'REJECTED')::int AS rejected_properties
        FROM properties
    `;
    const workspaceStats = await sql`
        SELECT
            COUNT(*)::int AS workspace_properties,
            COUNT(*) FILTER (WHERE route_active = TRUE)::int AS active_workspace_properties,
            COUNT(DISTINCT p.zip_code)::int AS zip_count
        FROM workspace_properties wp
        JOIN properties p ON p.id = wp.property_id
        WHERE wp.user_email = ${targetEmail}
    `;
    const storage = await sql`
        SELECT
            relname AS table_name,
            pg_total_relation_size(relid)::bigint AS total_bytes,
            pg_relation_size(relid)::bigint AS table_bytes,
            (pg_total_relation_size(relid) - pg_relation_size(relid))::bigint AS index_bytes
        FROM pg_catalog.pg_statio_user_tables
        WHERE relname IN ('properties', 'workspace_properties', 'property_sources', 'ingestion_metrics')
        ORDER BY relname
    `;
    const recentJobsRaw = await base44.asServiceRole.entities.FetchJob.list('-updated_date', 20);
    const recentJobs = asArray(recentJobsRaw).map((job: any) => ({
        id: job.id,
        status: job.status,
        phase: job.phase,
        progress_pct: job.progress_pct,
        user_email: job.user_email,
        error_message: job.error_message,
        updated_date: job.updated_date,
        completed_at: job.completed_at
    }));
    const failedJobs = recentJobs.filter((job: any) => job.status === 'failed');
    const runningJobs = recentJobs.filter((job: any) => job.status === 'running');
    const totalStorageBytes = storage.reduce((sum: number, row: any) => sum + Number(row.total_bytes || 0), 0);

    return Response.json({
        success: true,
        checked_at: new Date().toISOString(),
        user_email: targetEmail,
        property_stats: propertyStats[0],
        workspace_stats: workspaceStats[0],
        storage: {
            total_mb: Math.round((totalStorageBytes / 1024 / 1024) * 100) / 100,
            tables: storage.map((row: any) => ({
                table_name: row.table_name,
                total_mb: Math.round((Number(row.total_bytes) / 1024 / 1024) * 100) / 100,
                table_mb: Math.round((Number(row.table_bytes) / 1024 / 1024) * 100) / 100,
                index_mb: Math.round((Number(row.index_bytes) / 1024 / 1024) * 100) / 100
            }))
        },
        jobs: {
            recent_count: recentJobs.length,
            failed_count: failedJobs.length,
            running_count: runningJobs.length,
            recent: recentJobs
        }
    });
}

Deno.serve(async (req: Request) => {
    try {
        const base44 = createClientFromRequest(req);
        const caller = await base44.auth.me();
        if (!caller) return Response.json({ error: 'Authentication required' }, { status: 401 });
        const body = await req.json().catch(() => ({}));
        if (body?.view !== 'platform_command_center') {
            if (caller.role !== 'admin') {
                return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
            }
            return await runLegacyAdminDiagnostics(base44, caller, body);
        }
        if (!canViewPlatformCommandCenter(caller)) {
            return Response.json({ error: 'Forbidden: FirstKnock HQ access required' }, { status: 403 });
        }
        const timeZone = validTimeZone(body?.time_zone);
        if (!timeZone) {
            return Response.json({ error: 'Choose a valid time zone.' }, { status: 400 });
        }

        const service = base44.asServiceRole;
        const stripePromise = loadStripeLiveData();
        const [users, interactionLogs, canvasEvents, canvasPins, teamMembers, routes, stripeData] = await Promise.all([
            listAllEntityRecords(service.entities.User, 'Users'),
            listAllEntityRecords(service.entities.InteractionLog, 'Interaction logs'),
            listAllEntityRecords(service.entities.CanvasHouseEvent, 'Canvas house events'),
            listAllEntityRecords(service.entities.CanvasHousePin, 'Canvas house pins', '-last_event_at'),
            listAllEntityRecords(service.entities.TeamMember, 'Team members'),
            listAllEntityRecords(service.entities.SavedRoute, 'Saved routes'),
            stripePromise
        ]);

        const now = Date.now();
        const maps = buildIdentityMaps(users, teamMembers);
        const betaGrants = activeBetaGrants(users, now);
        const repPeriods = Object.fromEntries(PERIODS.map((period) => [
            period.id,
            buildRepPeriod(interactionLogs, canvasEvents, maps, period.days, now)
        ]));
        const repTrend = buildRepTrend(interactionLogs, canvasEvents, now, 30);
        const stripe = buildStripeAnalytics(stripeData, users, repTrend, betaGrants);
        const adoption = buildAdoptionActivity(
            interactionLogs,
            canvasEvents,
            maps,
            teamMembers,
            users,
            now,
            timeZone
        );
        const recentRepSales = buildRecentRepSales(interactionLogs, canvasEvents, maps);
        const currentSoldDoors = countCurrentSoldDoors(interactionLogs, canvasPins);
        const feed = [...(stripe.feed || []), ...recentRepSales]
            .sort((left, right) => (timestamp(right.occurred_at) || 0) - (timestamp(left.occurred_at) || 0))
            .slice(0, 75);
        const activeRouteStatuses = new Set(['active', 'in_progress']);
        const platformAdmins = users.filter((user) => normalized(user?.role) === 'admin').length;
        const managerAccounts = users.filter((user) => {
            const appRole = normalized(user?.app_role);
            return user?.is_owner === true || appRole === 'manager' || appRole === 'admin';
        }).length;

        return Response.json({
            success: true,
            generated_at: new Date(now).toISOString(),
            refresh_after_seconds: 60,
            source_health: {
                firstknock: { status: 'live', message: 'All app activity sources loaded' },
                stripe: stripe.source
            },
            rep: {
                periods: repPeriods,
                trend: stripe.trend,
                adoption,
                recent_sales: recentRepSales,
                field_ops: {
                    total_routes: routes.length,
                    active_routes: routes.filter((route) => activeRouteStatuses.has(normalized(route?.status))).length,
                    completed_routes: routes.filter((route) => normalized(route?.status) === 'completed').length,
                    precision_outcomes: interactionLogs.filter(isPrecisionDoorOutcome).length,
                    canvas_outcomes: canvasEvents.filter(isCanvasDoorOutcome).length,
                    canvas_homes: canvasPins.length,
                    current_sold_doors: currentSoldDoors,
                    team_members: teamMembers.length
                }
            },
            business: {
                ...stripe,
                total_app_accounts: users.length,
                manager_accounts: managerAccounts,
                platform_admins: platformAdmins
            },
            feed
        });
    } catch (error: any) {
        console.error('[adminDiagnostics]', error?.message || error);
        return Response.json({ error: 'Platform analytics could not be loaded completely. No partial totals were returned.' }, { status: 500 });
    }
});
