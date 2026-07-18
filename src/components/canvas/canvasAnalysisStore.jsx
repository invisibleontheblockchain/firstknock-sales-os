const storageKey = (scopeId) => scopeId ? `fk_canvasAnalysis:${String(scopeId)}` : null;

export function saveCanvasAnalysis(analysis, scopeId) {
  if (typeof window === 'undefined') return;
  const key = storageKey(scopeId);
  if (!key) return;
  try {
    sessionStorage.removeItem('fk_canvasAnalysis');
    if (analysis) sessionStorage.setItem(key, JSON.stringify(analysis));
    else sessionStorage.removeItem(key);
  } catch {}
  window.dispatchEvent(new CustomEvent('fk-canvas-analysis-updated', { detail: { analysis: analysis || null } }));
}

export function loadCanvasAnalysis(scopeId) {
  if (typeof window === 'undefined') return null;
  const key = storageKey(scopeId);
  if (!key) return null;
  try {
    sessionStorage.removeItem('fk_canvasAnalysis');
    const saved = sessionStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}
