// Remembers where a rep is in the Run Route list.
//
// Switching from FirstKnock to Maps or Messages and back often reloads the
// page: iOS and Android reclaim background web views, and an installed PWA
// comes back from scratch. Everything held in React state (the tab, the open
// house card, the scroll position) is gone, so the list opens at stop #1 again.
// This module keeps that position in localStorage, per route, so the page can
// put the rep back where they were.
//
// Kept free of React and DOM imports so the whole thing runs under node:test.

export const RUN_ROUTE_POSITION_KEY = 'fk_runRoutePosition';

// A route is worked within a shift. Positions older than this are stale: the
// rep expects a fresh list the next day, not yesterday's house card.
export const RUN_ROUTE_POSITION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const FILTER_STATUSES = ['all', 'todo', 'done', 'sold'];

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/** The key a Run Route card renders in `data-route-stop-hash`. */
export function getRouteStopKey(property) {
  return text(property?.address_hash || property?.id);
}

function readAll(storage) {
  try {
    const raw = storage?.getItem?.(RUN_ROUTE_POSITION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(storage, positions) {
  try {
    if (Object.keys(positions).length === 0) storage?.removeItem?.(RUN_ROUTE_POSITION_KEY);
    else storage?.setItem?.(RUN_ROUTE_POSITION_KEY, JSON.stringify(positions));
    return true;
  } catch {
    // Quota or private mode: the rep just loses the memory, nothing else.
    return false;
  }
}

function isFresh(record, now, maxAgeMs) {
  const savedAt = Number(record?.savedAt);
  return Number.isFinite(savedAt) && savedAt <= now + 60_000 && now - savedAt <= maxAgeMs;
}

function sanitize(routeId, position, now) {
  const todoRouteTypes = Array.isArray(position?.todoRouteTypes)
    ? position.todoRouteTypes.map(text).filter(Boolean)
    : null;
  return {
    routeId,
    stopKey: text(position?.stopKey) || null,
    openStopKey: text(position?.openStopKey) || null,
    filterStatus: FILTER_STATUSES.includes(position?.filterStatus) ? position.filterStatus : null,
    todoRouteTypes,
    savedAt: now,
  };
}

/**
 * The remembered position for `routeId`, or null when there is none, it is
 * stale, or storage is unreadable.
 */
export function readRunRoutePosition(storage, routeId, { now = Date.now(), maxAgeMs = RUN_ROUTE_POSITION_MAX_AGE_MS } = {}) {
  const id = text(routeId);
  if (!id) return null;
  const record = readAll(storage)[id];
  if (!record || !isFresh(record, now, maxAgeMs)) return null;
  const clean = sanitize(id, record, Number(record.savedAt));
  if (!clean.stopKey && !clean.openStopKey && !clean.filterStatus && !clean.todoRouteTypes) return null;
  return clean;
}

/**
 * Remember `position` for its route. Other routes' positions are kept, stale
 * ones are pruned so the record never grows past the routes worked recently.
 */
export function writeRunRoutePosition(storage, position, { now = Date.now(), maxAgeMs = RUN_ROUTE_POSITION_MAX_AGE_MS } = {}) {
  const id = text(position?.routeId);
  if (!id) return false;
  const positions = Object.fromEntries(
    Object.entries(readAll(storage)).filter(([key, record]) => key !== id && isFresh(record, now, maxAgeMs))
  );
  positions[id] = sanitize(id, position, now);
  return writeAll(storage, positions);
}

export function clearRunRoutePosition(storage, routeId) {
  const id = text(routeId);
  if (!id) return false;
  const positions = readAll(storage);
  if (!(id in positions)) return true;
  delete positions[id];
  return writeAll(storage, positions);
}

/**
 * Which rendered stop to scroll to when restoring `stopKey`.
 *
 * `routeKeys` is the full route order and `visibleKeys` the stops the current
 * tab shows. The remembered stop itself wins when it is visible; otherwise the
 * next visible stop after it in route order (the rep had just finished that
 * house, so it left the Todo tab), else the last visible stop before it.
 */
export function findRestoreStopKey(routeKeys = [], visibleKeys = [], stopKey) {
  const target = text(stopKey);
  if (!target || !visibleKeys.length) return null;
  const visible = new Set(visibleKeys.map(text).filter(Boolean));
  if (visible.has(target)) return target;
  const position = routeKeys.findIndex((key) => text(key) === target);
  if (position < 0) return null;
  for (let index = position + 1; index < routeKeys.length; index += 1) {
    const key = text(routeKeys[index]);
    if (visible.has(key)) return key;
  }
  for (let index = position - 1; index >= 0; index -= 1) {
    const key = text(routeKeys[index]);
    if (visible.has(key)) return key;
  }
  return null;
}

/**
 * The first stop still (partly) on screen, given each rendered stop's key and
 * vertical bounds plus the top edge of the scrolling list. Used when the app
 * goes to the background with no house card open, so plain scrolling is
 * remembered too.
 */
export function firstVisibleStopKey(stops = [], listTop = 0) {
  for (const stop of stops) {
    if (!stop || !text(stop.key)) continue;
    if (Number(stop.bottom) > Number(listTop) + 1) return text(stop.key);
  }
  return null;
}
