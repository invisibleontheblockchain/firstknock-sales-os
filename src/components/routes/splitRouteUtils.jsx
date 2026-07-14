export const getRouteStops = (route) => {
  if (Array.isArray(route?.properties) && route.properties.length > 0) return route.properties;
  return (route?.property_hashes || []).map((hash) => ({ address_hash: hash, id: hash }));
};

export const addDays = (dateString, offset) => {
  if (!dateString) return '';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

export const formatBatchDate = (dateString) => {
  if (!dateString) return '';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const buildSplitPreview = ({ route, stopsPerDay, startDate = '', assignmentMode = 'all', allRepId = '', perBatchRepIds = [], teamMembers = [] }) => {
  const stops = getRouteStops(route);
  const size = Number(stopsPerDay);
  if (!Number.isInteger(size) || size < 1 || stops.length === 0) return [];

  const memberMap = new Map(teamMembers.map((member) => [member.id, member]));
  const batches = [];
  for (let start = 0; start < stops.length; start += size) {
    const batchIndex = batches.length;
    const repId = assignmentMode === 'each' ? perBatchRepIds[batchIndex] || '' : allRepId || '';
    const rep = repId ? memberMap.get(repId) : null;
    batches.push({
      batchNumber: batchIndex + 1,
      batchTotal: Math.ceil(stops.length / size),
      stops: stops.slice(start, start + size),
      date: startDate ? addDays(startDate, batchIndex) : '',
      repId,
      repName: rep?.name || ''
    });
  }
  return batches;
};

export const buildSplitRouteRecords = ({ route, batches, managerId }) => {
  const safeMetadata = { ...(route?.metadata || {}) };
  delete safeMetadata.route_bounds;
  return batches.map((batch) => {
    const dateLabel = batch.date ? ` (${formatBatchDate(batch.date)})` : '';
    const routeName = `${route?.name || 'Route'} — Batch ${batch.batchNumber}${dateLabel}`;
    return {
      name: routeName,
      description: `Split batch ${batch.batchNumber} of ${batch.batchTotal} from ${route?.name || 'original route'}`,
      route_mode: route?.route_mode || 'precision',
      status: batch.repId ? 'ACTIVE' : 'PENDING',
      assigned_to: batch.repId || null,
      assigned_to_name: batch.repName || null,
      priority: Number(route?.priority || 0) + batch.batchNumber,
      property_hashes: batch.stops.map((stop) => stop.address_hash || stop.id).filter(Boolean),
      metrics: {
        distance: 0,
        house_count: batch.stops.length,
        score: route?.competitivenessScore || route?.metrics?.score || 0
      },
      start_location: null,
      route_origin_mode: 'none',
      metadata: safeMetadata,
      manager_id: route?.manager_id || managerId,
      parent_route_id: route?.id || null,
      batch_number: batch.batchNumber,
      batch_total: batch.batchTotal,
      batch_date: batch.date || null
    };
  });
};
