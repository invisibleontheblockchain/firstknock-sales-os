export function opportunitiesToDoorPoints(analysis) {
  const opportunities = Array.isArray(analysis?.opportunities) ? analysis.opportunities : [];
  return opportunities
    .map((item) => ({
      lat: Number(item.lat),
      lng: Number(item.lng),
      id: item.id,
      classificationConfidence: item.classificationConfidence,
      discoverySource: item.discoverySource
    }))
    .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}