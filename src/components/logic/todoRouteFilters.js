export const TODO_ROUTE_FILTER_OPTIONS = Object.freeze([
  { value: 'ELIGIBLE', label: 'Todo' },
  { value: 'NO_ANSWER', label: 'No Answer' },
  { value: 'NOT_MOVED_IN', label: 'Not Moved In' },
  { value: 'DM_NOT_HOME', label: 'DM Not Home' },
]);

export const DEFAULT_TODO_ROUTE_FILTERS = Object.freeze(['ELIGIBLE']);

export function todoRouteFilterKey(status = 'ELIGIBLE', workflowBucket = null) {
  if (workflowBucket === 'TODO') return 'ELIGIBLE';
  if (workflowBucket === 'CALLBACK') return 'CALLBACK';
  if (workflowBucket === 'RE_KNOCK') return 'RE_KNOCK';
  return status || 'ELIGIBLE';
}

export function matchesTodoRouteFilters(property, selectedFilters, status = property?.effective_status, workflowBucket = property?.workflow_bucket) {
  const key = todoRouteFilterKey(status || 'ELIGIBLE', workflowBucket);
  return selectedFilters instanceof Set
    ? selectedFilters.has(key)
    : Array.isArray(selectedFilters) && selectedFilters.includes(key);
}

export function countTodoRouteFilters(
  properties = [],
  statusForProperty = (property) => property?.effective_status,
  workflowBucketForProperty = (property) => property?.workflow_bucket
) {
  const counts = Object.fromEntries(TODO_ROUTE_FILTER_OPTIONS.map(({ value }) => [value, 0]));
  properties.forEach((property) => {
    const key = todoRouteFilterKey(statusForProperty(property) || 'ELIGIBLE', workflowBucketForProperty(property));
    if (counts[key] !== undefined) counts[key] += 1;
  });
  return counts;
}