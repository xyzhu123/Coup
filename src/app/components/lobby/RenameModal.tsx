'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { NAME_MAX_CODE_UNITS, NAME_MAX_LENGTH } from '@/shared/constants';
import { clampToGraphemes } from '@/shared/textLimits';
import { useT } from '../../i18n';
import { describeAckError } from '../../i18n/serverErrors';
import { getSocket } from '../../hooks/useSocket';
import { haptic } from '../../utils/haptic';
import { savePlayerName } from '../../utils/playerName';
import { Modal } from '../ui/Modal';

/** How long to wait for the server before giving the Save button back. */
const RENAME_TIMEOUT_MS = 5000;

interface RenameModalProps {
  open: boolean;
  onClose: () => void;
  /** The name the player has now. */
  currentName: string;
}

/**
 * Change your own name: in the lobby, and during a table mode game, so the
 * names on screen can match the people around the table.
 */
export function RenameModal({ open, onClose, currentName }: RenameModalProps) {
  const t = useT();
  const inputId = useId();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Each opening starts from the current name.
  useEffect(() => {
    if (open) { setName(currentName); setError(null); setPending(false); }
  }, [open, currentName]);

  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);

  const trimmed = name.trim();

  const submit = () => {
    if (pending || !trimmed) return;
    if (trimmed === currentName) { onClose(); return; }
    haptic(60);
    setPending(true);
    setError(null);
    let settled = false;
    timeout.current = setTimeout(() => {
      if (settled) return;
      settled = true;
      setPending(false);
      setError(t('errors.renameFailed'));
    }, RENAME_TIMEOUT_MS);
    getSocket().emit('room:rename', { name: trimmed }, response => {
      if (settled) return;
      settled = true;
      if (timeout.current) clearTimeout(timeout.current);
      setPending(false);
      if (response.success) {
        savePlayerName(response.name ?? trimmed);
        onClose();
      } else {
        setError(describeAckError(response, t('errors.renameFailed')));
      }
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={t('lobby.rename')}>
      <form onSubmit={e => { e.preventDefault(); submit(); }} className="flex flex-col gap-3">
        <label className="block text-sm text-coup-ink-mute" htmlFor={inputId}>{t('home.nameLabel')}</label>
        <input
          id={inputId}
          type="text"
          className="input-field w-full select-text"
          value={name}
          onChange={e => setName(clampToGraphemes(e.target.value, NAME_MAX_LENGTH))}
          maxLength={NAME_MAX_CODE_UNITS}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="done"
          autoFocus
        />
        {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}
        <div className="flex gap-3 mt-1">
          <button type="button" className="btn-secondary flex-1 min-h-14" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn-primary flex-1 min-h-14" disabled={pending || !trimmed}>{t('lobby.renameSave')}</button>
        </div>
      </form>
    </Modal>
  );
}
