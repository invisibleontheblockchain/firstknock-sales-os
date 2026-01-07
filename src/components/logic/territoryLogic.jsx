export const determineEffectiveStatus = (masterProp, logs) => {
    if (masterProp.original_status === 'SOLD') return 'SOLD';
    if (masterProp.original_status === 'HARD_NO') return 'HARD_NO';
    if (masterProp.original_status === 'GHOST') return 'ELIGIBLE'; // Default for ghosts
    
    if (!logs || logs.length === 0) return masterProp.original_status;
    
    // Sort logs by timestamp desc if not already
    const sortedLogs = [...logs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    const latestLog = sortedLogs[0];
    
    // Check cooldown for NO_ANSWER
    if (latestLog.parsed_status === 'NO_ANSWER') {
         const cooldownDate = new Date(latestLog.next_eligible_date);
         if (new Date() < cooldownDate) {
             return 'NO_ANSWER'; // Still cooling down
         } else {
             return 'ELIGIBLE'; // Cooldown expired
         }
    }
    
    return latestLog.parsed_status;
};