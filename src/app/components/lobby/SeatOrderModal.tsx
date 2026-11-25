'use client';

import { useEffect, useState } from 'react';
import type { ClientRoomPlayer } from '@/shared/types';
import { Modal } from '../ui/Modal';
import { haptic } from '../../utils/haptic';
import { useT } from '../../i18n';

interface SeatOrderModalProps {
  open: boolean;
  onClose: () => void;
  players: ClientRoomPlayer[];
  onSave: (playerIds: string[]) => void;
}

/**
 * Table mode: the host taps the players in clockwise order around the real
 * table, so turns in the app go round the same way. One tap per player.
 */
export function SeatOrderModal({ open, onClose, players, onSave }: SeatOrderModalProps) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);

  // Someone may join or leave while the dialog is open.
  const present = picked.filter(id => players.some(p => p.id === id));
  const complete = players.length > 0 && present.length === players.length;

  return (
    <Modal open={open} onClose={onClose} title={t('lobby.seatOrderTitle')}>
      <p className="text-sm text-coup-ink-mute mb-3">{t('lobby.seatOrderHelp')}</p>
      <ul className="flex flex-col gap-2 mb-4">
        {players.map(p => {
          const seat = present.indexOf(p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                className={`btn-secondary w-full flex items-center gap-3 text-start ${seat >= 0 ? 'opacity-60' : ''}`}
                aria-pressed={seat >= 0}
                disabled={seat >= 0}
                onClick={() => { haptic(); setPicked([...present, p.id]); }}
              >
                <span className="figure text-coup-accent w-6 text-center" aria-hidden={seat < 0}>
                  {seat >= 0 ? t.number(seat + 1) : ''}
                </span>
                <bdi className="min-w-0 flex-1 truncate">{p.name}</bdi>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1" disabled={present.length === 0} onClick={() => { haptic(); setPicked([]); }}>
          {t('lobby.seatOrderRestart')}
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          disabled={!complete}
          onClick={() => { haptic(80); onSave(present); onClose(); }}
        >
          {t('lobby.seatOrderSave')}
        </button>
      </div>
    </Modal>
  );
}
