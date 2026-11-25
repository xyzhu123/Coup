'use client';

import { useState } from 'react';
import { Character } from '@/shared/types';
import { useT } from '../../i18n';
import { haptic } from '../../utils/haptic';
import { CharactersTab, RulesTab } from '../home/HowToPlay';
import { Modal } from '../ui/Modal';

/** Table mode plays Classic: the five characters in the deck. */
const CLASSIC_CHARACTERS = [
  Character.Duke,
  Character.Assassin,
  Character.Captain,
  Character.Ambassador,
  Character.Contessa,
] as const;

type GuideTab = 'characters' | 'rules';

interface TableGuideProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The reference a player checks mid-game at the table. Its two tabs are How
 * to Play's own Characters and Actions and rules tabs, so the guide and the
 * rules reference can never say different things.
 */
export function TableGuide({ open, onClose }: TableGuideProps) {
  const t = useT();
  const [tab, setTab] = useState<GuideTab>('characters');

  const tabs: Array<{ id: GuideTab; label: string }> = [
    { id: 'characters', label: t('rules.tab.characters') },
    { id: 'rules', label: t('rules.tab.rules') },
  ];

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-bold">{t('game.table.guide')}</h2>
        <button
          type="button"
          className="court-icon-btn text-2xl leading-none"
          onClick={() => { haptic(); onClose(); }}
          aria-label={t('common.close')}
        >
          &times;
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4" role="tablist">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="how-to-play-tab"
            data-active={tab === id ? 'true' : 'false'}
            onClick={() => { haptic(); setTab(id); }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'characters' && <CharactersTab characters={CLASSIC_CHARACTERS} />}
      {tab === 'rules' && <RulesTab />}

      <button type="button" className="btn-primary w-full min-h-14 mt-4" onClick={onClose}>{t('common.close')}</button>
    </Modal>
  );
}
