export const HQ_SECTION_IDS = Object.freeze([
  'field',
  'adoption',
  'revenue',
  'pulse',
  'cash',
  'leaderboard',
  'live',
  'customers',
  'operations',
]);

export const DEFAULT_HQ_SECTION = 'field';

export function sectionFromHash(hash = '') {
  const candidate = String(hash).replace(/^#/, '').trim().toLowerCase();
  return HQ_SECTION_IDS.includes(candidate) ? candidate : DEFAULT_HQ_SECTION;
}

export function hashForSection(sectionId) {
  return `#${HQ_SECTION_IDS.includes(sectionId) ? sectionId : DEFAULT_HQ_SECTION}`;
}

export function nextSectionForKey(currentSection, key) {
  const currentIndex = Math.max(0, HQ_SECTION_IDS.indexOf(currentSection));
  if (key === 'Home') return HQ_SECTION_IDS[0];
  if (key === 'End') return HQ_SECTION_IDS[HQ_SECTION_IDS.length - 1];
  if (key === 'ArrowRight') return HQ_SECTION_IDS[(currentIndex + 1) % HQ_SECTION_IDS.length];
  if (key === 'ArrowLeft') return HQ_SECTION_IDS[(currentIndex - 1 + HQ_SECTION_IDS.length) % HQ_SECTION_IDS.length];
  return null;
}
