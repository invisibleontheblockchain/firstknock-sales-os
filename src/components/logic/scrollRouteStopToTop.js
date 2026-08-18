function findScrollContainer(element) {
  let parent = element?.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return null;
}

export function scrollRouteStopToTop(element) {
  if (!element) return;
  const container = findScrollContainer(element);
  if (!container) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const top = container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({ top, behavior: 'smooth' });
}

export function scheduleRouteStopAtTop(getElement) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => scrollRouteStopToTop(getElement()));
  });
}