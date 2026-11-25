'use client';

import { useState, type ReactNode } from 'react';
import { ASSASSINATE_COST, COUP_COST } from '@/shared/constants';
import { ActionType, Character } from '@/shared/types';
import { actionName, characterName, useT } from '../../i18n';
import { CHARACTER_PALETTE } from '../../utils/characterPalette';
import { haptic } from '../../utils/haptic';
import { FOREIGN_AID_COINS, INCOME_COINS, TAX_COINS, learnParams } from '../../utils/learnText';
import { CharactersTab } from '../home/HowToPlay';
import { CoinIcon } from '../icons';
import { Modal } from '../ui/Modal';

/** Table mode plays Classic: the five characters in the deck. */
const CLASSIC_CHARACTERS = [
  Character.Duke,
  Character.Assassin,
  Character.Captain,
  Character.Ambassador,
  Character.Contessa,
] as const;

type GuideTab = 'characters' | 'actions';

interface GuideAction {
  action: ActionType;
  cost: number;
  effect: string;
  claims?: Character;
  blockedBy: readonly Character[];
}

interface TableGuideProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The reference a player checks mid-game at the table: who does what, and
 * what each action costs, claims and is blocked by. Two tabs, read at a
 * glance on a phone; the words are the `rules` catalog's, so they match How
 * to Play.
 */
export function TableGuide({ open, onClose }: TableGuideProps) {
  const t = useT();
  const [tab, setTab] = useState<GuideTab>('characters');
  const p = learnParams(t);

  const gain = (amount: number) => t('rules.effect.gain', { amount });
  const actions: GuideAction[] = [
    { action: ActionType.Income, cost: 0, effect: gain(INCOME_COINS), blockedBy: [] },
    { action: ActionType.ForeignAid, cost: 0, effect: gain(FOREIGN_AID_COINS), blockedBy: [Character.Duke] },
    { action: ActionType.Coup, cost: COUP_COST, effect: t('rules.effect.loseInfluence', p), blockedBy: [] },
    { action: ActionType.Tax, cost: 0, effect: gain(TAX_COINS), claims: Character.Duke, blockedBy: [] },
    { action: ActionType.Assassinate, cost: ASSASSINATE_COST, effect: t('rules.effect.loseInfluence', p), claims: Character.Assassin, blockedBy: [Character.Contessa] },
    { action: ActionType.Steal, cost: 0, effect: t('rules.effect.steal', p), claims: Character.Captain, blockedBy: [Character.Captain, Character.Ambassador] },
    { action: ActionType.Exchange, cost: 0, effect: t('rules.effect.exchange', p), claims: Character.Ambassador, blockedBy: [] },
  ];

  const character = (c: Character): ReactNode => (
    <span className={`font-medium ${CHARACTER_PALETTE[c].text}`}>{characterName(t, c)}</span>
  );

  const tabs: Array<{ id: GuideTab; label: string }> = [
    { id: 'characters', label: t('rules.tab.characters') },
    { id: 'actions', label: t('rules.actionsHeading') },
  ];

  return (
    <Modal open={open} onClose={onClose}>
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

      {tab === 'actions' && (
        <div className="flex flex-col gap-4 text-sm">
          <ul className="grid gap-2">
            {actions.map(({ action, cost, effect, claims, blockedBy }) => (
              <li key={action} className="panel-sunk px-3 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`font-bold ${claims ? CHARACTER_PALETTE[claims].text : 'text-white'}`}>
                    {actionName(t, action)}
                  </span>
                  {cost > 0 && (
                    <span className="flex items-center gap-1 text-coup-gold figure shrink-0">
                      <span className="text-xs text-coup-ink-mute">{t('rules.table.cost')}</span>
                      <CoinIcon size={14} />{t.number(cost)}
                    </span>
                  )}
                </div>
                <p className="text-gray-300">{effect}</p>
                {(claims || blockedBy.length > 0) && (
                  <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    {claims && (
                      <div className="flex gap-1.5">
                        <dt className="text-coup-ink-mute">{t('rules.table.claims')}</dt>
                        <dd>{character(claims)}</dd>
                      </div>
                    )}
                    {blockedBy.length > 0 && (
                      <div className="flex gap-1.5">
                        <dt className="text-coup-ink-mute">{t('rules.table.blockedBy')}</dt>
                        <dd>
                          {blockedBy.length === 2
                            ? t.rich('rules.table.pair', { first: character(blockedBy[0]), second: character(blockedBy[1]) })
                            : character(blockedBy[0])}
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </li>
            ))}
          </ul>

          <div>
            <h3 className="text-coup-accent font-bold text-base mb-1">{t('rules.challengeHeading')}</h3>
            <p className="text-gray-400">{t('rules.challenge', p)}</p>
          </div>
          <div>
            <h3 className="text-coup-accent font-bold text-base mb-1">{t('rules.blockHeading')}</h3>
            <p className="text-gray-400">{t('rules.block', p)}</p>
          </div>
          <div>
            <h3 className="text-coup-accent font-bold text-base mb-1">{t('rules.forcedHeading', p)}</h3>
            <p className="text-gray-400">{t('rules.forced', p)}</p>
          </div>
        </div>
      )}

      <button type="button" className="btn-primary w-full min-h-14 mt-4" onClick={onClose}>{t('common.close')}</button>
    </Modal>
  );
}
