export function saveCanvasAnalysis(analysis) {
  if (typeof window === 'undefined') return;
  window.__fkCanvasAnalysis = analysis || null;
  try {
    if (analysis) sessionStorage.setItem('fk_canvasAnalysis', JSON.stringify(analysis));
    else sessionStorage.removeItem('fk_canvasAnalysis');
  } catch {}
  window.dispatchEvent(new CustomEvent('fk-canvas-analysis-updated', { detail: { analysis: analysis || null } }));
}

export function loadCanvasAnalysis() {
  if (typeof window === 'undefined') return null;
  try {
    if (window.__fkCanvasAnalysis) return window.__fkCanvasAnalysis;
    const saved = sessionStorage.getItem('fk_canvasAnalysis');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}