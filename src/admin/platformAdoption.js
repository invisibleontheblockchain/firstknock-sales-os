function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function buildPlatformAdoptionView(adoption) {
  const reps = Array.isArray(adoption?.reps) ? adoption.reps : [];
  const members = [];
  const activity = [];

  for (const rep of reps) {
    const key = String(rep?.key || '').trim();
    if (!key) continue;

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
        callbacks: finiteMetric(bucket?.callbacks),
        knock_logs: finiteMetric(bucket?.knock_logs),
        canvas_logs: finiteMetric(bucket?.canvas_logs),
        last_activity: bucket?.last_activity_at || null,
      });
    }
  }

  return { members, activity };
}
