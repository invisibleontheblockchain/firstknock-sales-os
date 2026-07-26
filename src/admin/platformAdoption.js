const HIDDEN_PLATFORM_ANALYTICS_NAMES = new Set([
  'irobot v2',
  'irobotv2',
  'nick cohen',
  'nicholas cohen',
  'cory larson',
]);

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildPlatformAdoptionView(adoption) {
  const reps = Array.isArray(adoption?.reps) ? adoption.reps : [];
  const members = [];
  const activity = [];

  for (const rep of reps) {
    const key = String(rep?.key || '').trim();
    if (!key || HIDDEN_PLATFORM_ANALYTICS_NAMES.has(normalizedName(rep?.name))) continue;

    members.push({
      id: key,
      name: String(rep?.name || rep?.email || 'Unnamed user'),
      email: String(rep?.email || ''),
      role: String(rep?.team_name || 'Independent'),
      team_name: String(rep?.team_name || 'Independent'),
    });

    for (const [date, bucket] of Object.entries(rep?.days || {})) {
      activity.push({
        date,
        actor_team_member_id: key,
        logs: finiteMetric(bucket?.logs),
        doors: finiteMetric(bucket?.doors),
        sales: finiteMetric(bucket?.sales),
        recorded_sales_volume: finiteMetric(bucket?.recorded_sales_volume),
        callbacks: finiteMetric(bucket?.callbacks),
        knock_logs: finiteMetric(bucket?.knock_logs),
        canvas_logs: finiteMetric(bucket?.canvas_logs),
        last_activity: bucket?.last_activity_at || null,
      });
    }
  }

  return { members, activity };
}
