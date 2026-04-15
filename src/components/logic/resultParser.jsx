import moment from 'moment';

/**
 * Parse free-form result text according to master system rules
 */
export function parseResultText(text) {
    if (!text || !text.trim()) {
        return { status: 'ELIGIBLE', notes: '', nextDate: null, callbackTarget: null };
    }

    const lower = text.toLowerCase().trim();
    
    // SOLD / CLOSED
    if (lower.includes('sold') || lower.includes('closed') || lower.includes('signed') || lower.includes('deal')) {
        return {
            status: 'SOLD',
            notes: text,
            nextDate: null,
            callbackTarget: null
        };
    }
    
    // QUALIFIED / INTERESTED
    if (lower.includes('qualified') || lower.includes('interested') || lower.includes('hot lead')) {
        return {
            status: 'QUALIFIED',
            notes: text,
            nextDate: null,
            callbackTarget: null
        };
    }
    
    // CALLBACK with month detection
    if (lower.includes('back') || lower.includes('callback') || lower.includes('call back') || lower.includes('return')) {
        const monthMatch = text.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
        
        let callbackTarget = null;
        let nextDate = moment().add(1, 'month').startOf('month');
        
        if (monthMatch) {
            const monthName = monthMatch[0];
            const targetMonth = moment(monthName, 'MMMM').month();
            const currentMonth = moment().month();
            
            callbackTarget = moment().month(targetMonth).format('YYYY-MM');
            nextDate = moment().month(targetMonth).startOf('month');
            
            // If target month is in the past, assume next year
            if (targetMonth < currentMonth) {
                callbackTarget = moment().add(1, 'year').month(targetMonth).format('YYYY-MM');
                nextDate = moment().add(1, 'year').month(targetMonth).startOf('month');
            }
        }
        
        return {
            status: 'CALLBACK',
            notes: text,
            nextDate: nextDate.toISOString(),
            callbackTarget: callbackTarget
        };
    }
    
    // NOT MOVED IN
    if (lower.includes('not moved in') || lower.includes('haven\'t moved') || lower.includes('hasnt moved') || lower.includes('nmi')) {
        return {
            status: 'NOT_MOVED_IN',
            notes: text,
            nextDate: moment().add(30, 'days').toISOString(),
            callbackTarget: null
        };
    }

    // DECISION MAKER NOT HOME
    if (lower.includes('decision maker') || lower.includes('dm not home') || lower.includes('husband not home') || lower.includes('wife not home') || lower.includes('spouse')) {
        return {
            status: 'DM_NOT_HOME',
            notes: text,
            nextDate: moment().add(3, 'days').toISOString(),
            callbackTarget: null
        };
    }

    // NO_ANSWER / NOT HOME
    if (lower.includes('no answer') || lower.includes('not home') || lower.includes('nh') || lower.includes('nobody')) {
        return {
            status: 'NO_ANSWER',
            notes: text,
            nextDate: moment().add(14, 'days').toISOString(),
            callbackTarget: null
        };
    }
    
    // HARD_NO
    if (lower.includes('not interested') || lower.includes('dni') || lower.includes('do not') || lower.includes('go away') || lower === 'no') {
        return {
            status: 'HARD_NO',
            notes: text,
            nextDate: null,
            callbackTarget: null
        };
    }
    
    // OTHER - unrecognized
    return {
        status: 'OTHER',
        notes: text,
        nextDate: null,
        callbackTarget: null
    };
}

/**
 * Determine if property is eligible based on latest result and rules
 */
export function isPropertyEligible(property, dailyResults) {
    const propResults = dailyResults.filter(r => r.address_hash === property.address_hash);
    
    if (propResults.length === 0) {
        return property.original_status === 'ELIGIBLE';
    }
    
    // Sort by most recent
    const sorted = propResults.sort((a, b) => new Date(b.date_visited) - new Date(a.date_visited));
    const latest = sorted[0];
    
    // SOLD and HARD_NO are permanent exclusions
    if (latest.parsed_status === 'SOLD' || latest.parsed_status === 'HARD_NO') {
        return false;
    }
    
    // CALLBACK - check if eligible date has passed
    if (latest.parsed_status === 'CALLBACK' && latest.next_eligible_date) {
        return moment().isAfter(moment(latest.next_eligible_date));
    }
    
    // NO_ANSWER - check cooldown period (14 days)
    if (latest.parsed_status === 'NO_ANSWER' && latest.next_eligible_date) {
        return moment().isAfter(moment(latest.next_eligible_date));
    }

    // NOT_MOVED_IN - check cooldown (30 days)
    if (latest.parsed_status === 'NOT_MOVED_IN' && latest.next_eligible_date) {
        return moment().isAfter(moment(latest.next_eligible_date));
    }

    // DM_NOT_HOME - check cooldown (3 days)
    if (latest.parsed_status === 'DM_NOT_HOME' && latest.next_eligible_date) {
        return moment().isAfter(moment(latest.next_eligible_date));
    }
    
    return true;
}