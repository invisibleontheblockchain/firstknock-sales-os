import React from 'react';
import { base44 } from '@/api/base44Client';
import { useQueryClient } from '@tanstack/react-query';

const SELECTORS = {
  draw: '.leaflet-container',
  filters: '[data-onboarding="precision-panel"]',
  ready: '[data-onboarding="route-checklist"]',
};

export function useFirstAreaWalkthrough(user) {
  const queryClient = useQueryClient();
  const key = user?.id ? `fk_firstAreaWalkthrough_${user.id}` : null;
  const [active, setActive] = React.useState(false);
  const [phase, setPhase] = React.useState('draw');

  React.useEffect(() => {
    if (!key || user?.app_role !== 'manager' || user?.has_seen_onboarding) return;
    const requested = new URLSearchParams(window.location.search).get('onboarding') === 'precision';
    if (requested) localStorage.setItem(key, 'active');
    setActive(localStorage.getItem(key) === 'active');
  }, [key, user?.app_role, user?.has_seen_onboarding]);

  React.useEffect(() => {
    if (!active) return undefined;
    const refresh = () => {
      if (document.querySelector(SELECTORS.ready)) setPhase('ready');
      else if (document.querySelector(SELECTORS.filters)) setPhase('filters');
      else setPhase(current => current === 'building' ? current : 'draw');
    };
    const building = () => setPhase('building');
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('fk-first-area-building', building);
    refresh();
    return () => { observer.disconnect(); window.removeEventListener('fk-first-area-building', building); };
  }, [active]);

  React.useEffect(() => {
    if (!active) return undefined;
    const target = document.querySelector(SELECTORS[phase]);
    target?.classList.add('fk-onboarding-focus');
    return () => target?.classList.remove('fk-onboarding-focus');
  }, [active, phase]);

  const finish = React.useCallback(async () => {
    setActive(false);
    if (key) localStorage.setItem(key, 'done');
    await base44.auth.updateMe({ has_seen_onboarding: true });
    queryClient.invalidateQueries({ queryKey: ['user'] });
  }, [key, queryClient]);

  return { active, phase, finish };
}