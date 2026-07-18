const DEFAULT_CANVAS_ROSTER_PAGE_SIZE = 250;
const DEFAULT_CANVAS_ROSTER_MAX_PAGES = 40;

function pageRows(response) {
  return Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
}

function teamMemberKey(member = {}) {
  const id = String(member.id || '').trim();
  if (id) return `id:${id}`;

  // Canvas eligibility rejects records without an entity id, but retaining a
  // stable fallback key keeps the shared manager roster deterministic too.
  return [
    'missing-id',
    member.manager_id,
    member.user_id,
    member.email,
    member.role,
    member.status,
    member.created_date,
  ].map((value) => String(value || '').trim()).join('\u0000');
}

export async function fetchAllCanvasTeamMembers(
  fetchPage,
  { pageSize = DEFAULT_CANVAS_ROSTER_PAGE_SIZE, maxPages = DEFAULT_CANVAS_ROSTER_MAX_PAGES } = {},
) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');

  const safePageSize = Math.max(1, Math.min(
    DEFAULT_CANVAS_ROSTER_PAGE_SIZE,
    Math.floor(Number(pageSize) || DEFAULT_CANVAS_ROSTER_PAGE_SIZE),
  ));
  const safeMaxPages = Math.max(1, Math.floor(Number(maxPages) || DEFAULT_CANVAS_ROSTER_MAX_PAGES));
  const membersByKey = new Map();
  const seenPageFingerprints = new Set();

  for (let pageIndex = 0; pageIndex < safeMaxPages; pageIndex += 1) {
    const skip = pageIndex * safePageSize;
    const page = pageRows(await fetchPage(safePageSize, skip));
    if (!page.length) return [...membersByKey.values()];

    const fingerprint = page.map(teamMemberKey).join('|');
    if (seenPageFingerprints.has(fingerprint)) {
      throw new Error('Canvas roster pagination repeated a page before reaching the end.');
    }
    seenPageFingerprints.add(fingerprint);

    page.forEach((member) => {
      const key = teamMemberKey(member);
      if (!membersByKey.has(key)) membersByKey.set(key, member);
    });

    if (page.length < safePageSize) return [...membersByKey.values()];
  }

  throw new Error(`Canvas roster query exceeded ${safeMaxPages.toLocaleString()} pages.`);
}
