import React from 'react';
import { base44 } from '@/api/base44Client';
import HouseNoteField from '@/components/routes/HouseNoteField';
import { latestOutcomeNote } from '@/components/logic/outcomeStatus';

/**
 * "Add Details" note for the manager property card.
 *
 * Same durable house note the checklist writes (one non-metered row per house,
 * updated in place), so a note added from the map is the note a rep reads in the
 * field. It autosaves on a pause and never claims a save the server rejected.
 */
export default function PropertyNoteSection({ property, logs = [], routeId = null, onSaved }) {
  const savedNote = latestOutcomeNote(logs);
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(undefined);
  const [state, setState] = React.useState(null);
  const [error, setError] = React.useState('');
  const timerRef = React.useRef(null);

  React.useEffect(() => {
    setOpen(false);
    setDraft(undefined);
    setState(null);
    setError('');
  }, [property?.address_hash]);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  const persist = React.useCallback(async (value) => {
    setState('saving');
    try {
      await base44.functions.invoke('recordKnockOutcome', {
        action: 'save_house_note',
        address_hash: property.address_hash,
        note: value,
        route_id: routeId,
      });
      setState('saved');
      setError('');
      onSaved?.();
    } catch (err) {
      const reason = err?.response?.data?.error || err?.response?.data?.code || err?.message || 'Unknown error';
      console.error('[PropertyNoteSection] House note save failed', err);
      setState('error');
      setError(String(reason));
    }
  }, [onSaved, property?.address_hash, routeId]);

  const handleChange = (_property, value) => {
    setDraft(value);
    setState('saving');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persist(value), 800);
  };

  const flush = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    if (draft !== undefined) persist(draft);
  };

  const badge = state === 'error' ? 'Not saved' : state === 'saving' ? 'Saving' : (savedNote ? 'Saved' : null);

  return (
    <HouseNoteField
      property={property}
      open={open}
      onToggle={() => {
        if (open) flush();
        setOpen(!open);
      }}
      value={draft ?? savedNote}
      savedNote={savedNote}
      noteState={state}
      noteBadge={badge}
      noteError={error}
      onChange={handleChange}
      onFlush={flush}
    />
  );
}