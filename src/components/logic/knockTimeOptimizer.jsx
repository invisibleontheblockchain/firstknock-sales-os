/**
 * Smart Knock Time Optimizer
 * Calculates the best time to visit properties based on multiple factors
 */

// Day of week: 0 = Sunday, 6 = Saturday
const BASE_TIME_SCORES = {
  weekday: {
    // Hour: Score (0-100)
    6: 5, 7: 10, 8: 15, 9: 20, 10: 25, 11: 30,
    12: 35, 13: 35, 14: 40, 15: 50, 16: 60,
    17: 85, 18: 95, 19: 90, 20: 70, 21: 30
  },
  saturday: {
    8: 40, 9: 70, 10: 85, 11: 90, 12: 75,
    13: 60, 14: 55, 15: 60, 16: 70, 17: 75,
    18: 65, 19: 50, 20: 30
  },
  sunday: {
    // Generally avoid mornings on Sunday
    8: 5, 9: 10, 10: 15, 11: 20, 12: 30,
    13: 40, 14: 55, 15: 60, 16: 65, 17: 60,
    18: 50, 19: 40, 20: 25
  }
};

// Property type modifiers
const PROPERTY_TYPE_MODIFIERS = {
  // Retirement/55+ communities - invert schedule (best mid-day)
  senior: {
    weekday: { 10: 90, 11: 95, 12: 85, 13: 80, 14: 75, 15: 60, 17: 30, 18: 20 },
    saturday: { 10: 85, 11: 90, 12: 80, 14: 70, 17: 40 },
    sunday: { 12: 60, 13: 70, 14: 75, 15: 70 }
  }
};

/**
 * Get base time score for current day/hour
 */
export function getBaseTimeScore(date = new Date()) {
  const day = date.getDay();
  const hour = date.getHours();
  
  let schedule;
  if (day === 0) schedule = BASE_TIME_SCORES.sunday;
  else if (day === 6) schedule = BASE_TIME_SCORES.saturday;
  else schedule = BASE_TIME_SCORES.weekday;
  
  return schedule[hour] || 0;
}

/**
 * Get descriptive label for current knock window
 */
export function getKnockWindowLabel(date = new Date()) {
  const score = getBaseTimeScore(date);
  
  if (score >= 85) return { label: 'PRIME TIME', color: '#22c55e', emoji: '🔥' };
  if (score >= 60) return { label: 'GOOD', color: '#eab308', emoji: '👍' };
  if (score >= 40) return { label: 'FAIR', color: '#f97316', emoji: '⏳' };
  if (score >= 20) return { label: 'LOW', color: '#ef4444', emoji: '⚠️' };
  return { label: 'AVOID', color: '#6b7280', emoji: '🚫' };
}

/**
 * Calculate next best knock window
 */
export function getNextBestWindow(fromDate = new Date()) {
  const windows = [];
  const now = new Date(fromDate);
  
  // Check next 48 hours in 1-hour increments
  for (let i = 0; i < 48; i++) {
    const checkTime = new Date(now.getTime() + i * 60 * 60 * 1000);
    const score = getBaseTimeScore(checkTime);
    
    if (score >= 80) {
      windows.push({
        time: checkTime,
        score,
        label: formatTimeWindow(checkTime)
      });
    }
  }
  
  return windows.slice(0, 3); // Return top 3 upcoming windows
}

/**
 * Format time window for display
 */
function formatTimeWindow(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = days[date.getDay()];
  const hour = date.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  
  const isToday = new Date().toDateString() === date.toDateString();
  const isTomorrow = new Date(Date.now() + 86400000).toDateString() === date.toDateString();
  
  const dayLabel = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : day;
  
  return `${dayLabel} ${displayHour}${ampm}`;
}

/**
 * Get optimal route order based on property characteristics and time
 * Properties with higher "contact probability" should be visited first during prime time
 */
export function optimizeRouteForTime(properties, currentTime = new Date()) {
  const hour = currentTime.getHours();
  const baseScore = getBaseTimeScore(currentTime);
  
  // If it's prime time, prioritize high-value targets first
  // If it's off-peak, start with "easy wins" (recently sold, likely home)
  
  return properties.map(p => ({
    ...p,
    timeScore: calculatePropertyTimeScore(p, currentTime),
  })).sort((a, b) => b.timeScore - a.timeScore);
}

/**
 * Calculate individual property's time-adjusted score
 */
function calculatePropertyTimeScore(property, time) {
  let score = getBaseTimeScore(time);
  
  // Boost recently sold (eager to talk about new home)
  if (property.sold_date) {
    const daysSinceSold = Math.floor((Date.now() - new Date(property.sold_date).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceSold < 30) score += 20;
    else if (daysSinceSold < 90) score += 10;
  }
  
  // Higher value homes might have stay-at-home spouse (better mid-day)
  const hour = time.getHours();
  if (property.price && property.price > 500000 && hour >= 10 && hour <= 14) {
    score += 10;
  }
  
  return Math.min(100, score);
}

/**
 * Get daily schedule recommendation
 */
export function getDailySchedule(date = new Date()) {
  const day = date.getDay();
  
  if (day === 0) {
    return {
      avoid: '8am - 12pm',
      good: '2pm - 5pm',
      best: 'Consider other days',
      tip: 'Sunday mornings are generally not recommended for door-to-door.'
    };
  }
  
  if (day === 6) {
    return {
      avoid: 'Before 9am, After 7pm',
      good: '12pm - 4pm',
      best: '9am - 12pm',
      tip: 'Saturday mornings are great - people are doing chores and projects.'
    };
  }
  
  return {
    avoid: '8am - 11am, After 8pm',
    good: '3pm - 5pm',
    best: '5pm - 7pm',
    tip: 'Prime time is when people return from work. Dinner time (6-7pm) can still work.'
  };
}

/**
 * Simple weather modifier (can be enhanced with real API later)
 */
export function getWeatherModifier(conditions) {
  const modifiers = {
    clear: 10,
    cloudy: 5,
    rain: -20,
    snow: -30,
    hot: -10, // >95°F
    cold: -5  // <40°F
  };
  
  return modifiers[conditions] || 0;
}