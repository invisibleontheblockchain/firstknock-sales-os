/**
 * NLP Result Parser - Converts free-form text to structured status
 */
import moment from 'moment';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 
                'july', 'august', 'september', 'october', 'november', 'december'];

export function parseResultText(text) {
    if (!text || !text.trim()) {
        return { status: 'OTHER', nextDate: null, callbackTarget: null };
    }
    
    const lower = text.toLowerCase().trim();
    
    // SOLD detection
    if (/\b(sold|closed|signed|deal|purchased|bought)\b/.test(lower)) {
        return { status: 'SOLD', nextDate: null, callbackTarget: null };
    }
    
    // QUALIFIED detection
    if (/\b(qualified|interested|wants|scheduled|appointment|appt)\b/.test(lower)) {
        return { status: 'QUALIFIED', nextDate: null, callbackTarget: null };
    }
    
    // HARD_NO detection
    if (/\b(not interested|go away|never|dni|do not|don't come|hostile|rude|angry)\b/.test(lower)) {
        return { status: 'HARD_NO', nextDate: null, callbackTarget: null };
    }
    
    // NO_ANSWER detection - eligible again in 14 days
    if (/\b(nh|n\/a|no answer|nobody|not home|no one|vacant|empty)\b/.test(lower)) {
        return { 
            status: 'NO_ANSWER', 
            nextDate: moment().add(14, 'days').toISOString(),
            callbackTarget: null 
        };
    }
    
    // CALLBACK detection with date parsing
    if (/\b(call\s*back|come\s*back|return|later|tomorrow|next\s*week|next\s*month)\b/.test(lower)) {
        let nextDate = moment().add(7, 'days'); // Default 1 week
        let callbackTarget = null;
        
        // Check for tomorrow
        if (/tomorrow/.test(lower)) {
            nextDate = moment().add(1, 'day');
        }
        // Check for next week
        else if (/next\s*week/.test(lower)) {
            nextDate = moment().add(7, 'days');
        }
        // Check for next month
        else if (/next\s*month/.test(lower)) {
            nextDate = moment().add(1, 'month');
        }
        // Check for specific month
        else {
            for (let i = 0; i < MONTHS.length; i++) {
                if (lower.includes(MONTHS[i]) || lower.includes(MONTHS[i].substring(0, 3))) {
                    const targetMonth = i;
                    const currentMonth = moment().month();
                    let targetYear = moment().year();
                    
                    // If month has passed, assume next year
                    if (targetMonth <= currentMonth) {
                        targetYear++;
                    }
                    
                    nextDate = moment().year(targetYear).month(targetMonth).date(1);
                    callbackTarget = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;
                    break;
                }
            }
        }
        
        return { 
            status: 'CALLBACK', 
            nextDate: nextDate.toISOString(),
            callbackTarget 
        };
    }
    
    // Default to OTHER
    return { status: 'OTHER', nextDate: null, callbackTarget: null };
}

/**
 * Determine effective status based on property and visit history
 */
export function getEffectiveStatus(property, results = []) {
    // Check original status first
    if (property.original_status === 'SOLD' || property.original_status === 'HARD_NO' || property.original_status === 'DO_NOT_KNOCK') {
        return property.original_status;
    }
    
    // No results = use original status
    if (!results || results.length === 0) {
        return property.original_status || 'ELIGIBLE';
    }
    
    // Get most recent result
    const sortedResults = [...results].sort((a, b) => 
        new Date(b.date_visited) - new Date(a.date_visited)
    );
    const latest = sortedResults[0];
    
    // Permanent statuses
    if (latest.parsed_status === 'SOLD' || latest.parsed_status === 'HARD_NO') {
        return latest.parsed_status;
    }
    
    // Check if cooldown has passed
    if (latest.next_eligible_date) {
        const eligibleDate = moment(latest.next_eligible_date);
        if (moment().isBefore(eligibleDate)) {
            return latest.parsed_status; // Still in cooldown
        }
    }
    
    // Cooldown passed or no cooldown - eligible again
    return 'ELIGIBLE';
}