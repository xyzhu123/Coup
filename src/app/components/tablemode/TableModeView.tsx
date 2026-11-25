'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ASSASSINATE_COST, COUP_COST, EXCHANGE_DRAW_COUNT, FOREIGN_AID_COINS, INCOME_COINS, STEAL_COINS, TAX_COINS } from '@/shared/constants';
import { ActionType, GameStatus, TurnPhase, type ClientGameState, type ClientPlayerState, type TableAction } from '@/shared/types';
import { actionName, characterName, useT } from '../../i18n';
import { getSocket } from '../../hooks/useSocket';
import { useGameStore } from '../../stores/gameStore';
import { haptic, hapticHeavy } from '../../utils/haptic';
import { CardFace } from '../game/CardFace';
import { LogCharacter, LogStamp, renderLogText, useLogContext } from '../game/LogLine';
import { CardBack, CoinIcon } from '../icons';
import { SettingsModal } from '../settings/SettingsModal';
import { Modal } from '../ui/Modal';

interface TableModeViewProps {
  gameState: ClientGameState;
  isHost: boolean;
  isSpectator: boolean;
  /** Host: send everyone back to the lobby after the game. */
  onRematch: () => void;
  /** Leave the table for good (your cards are turned up). */
  onLeave?: () => void;
}

/** Your own card's sheet: choose what to do with it, then confirm. */
type CardSheet = { index: number; step: 'choose' | 'lose' | 'show' };

const HIDDEN_CARD = { character: null, revealed: false } as const;
/** A press on your own card shorter than this opens its options; longer is a look. */
const PEEK_HOLD_MS = 200;
/** After a turn entry is sent, the buttons stay off this long unless the server answers first. */
const ENTRY_LOCK_MS = 1500;
/** A confirm button stays off this long after it appears, so a double tap cannot land on it. */
const CONFIRM_ARM_MS = 400;

/** False for a moment after `open` turns true; true from then until it closes. */
function useArmed(open: boolean): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!open) { setArmed(false); return; }
    const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return armed;
}

/**
 * Table mode: the screen for playing in person.
 *
 * The phone is the deck, your hand and the coins. Claims, challenges and
 * blocks are said out loud; whoever an outcome belongs to records it here.
 *
 * Built for a phone held at a crowded table:
 *   - Only what you can use right now is on screen. The entry buttons appear
 *     on your turn and are gone the rest of the time.
 *   - A coin entry is one tap and can be taken back with one tap. Anything
 *     that cannot be taken back (a card turned up, cards drawn) asks first.
 *   - Your cards stay face down until you hold one, because the people you
 *     are bluffing sit next to you.
 *   - Rare things (corrections, leaving, the host moving a turn on) live
 *     behind More, away from the thumb.
 */
export function TableModeView({ gameState, isHost, isSpectator, onRematch, onLeave }: TableModeViewProps) {
  const t = useT();
  const socket = getSocket();
  const roomPlayers = useGameStore(s => s.roomPlayers);
  const logContext = useLogContext(gameState.players);

  const [peekIndex, setPeekIndex] = useState<number | null>(null);
  const [cardSheet, setCardSheet] = useState<CardSheet | null>(null);
  const [showSteal, setShowSteal] = useState(false);
  const [showExchangeAsk, setShowExchangeAsk] = useState(false);
  const [showCorrect, setShowCorrect] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [keep, setKeep] = useState<number[]>([]);
  const [entryLocked, setEntryLocked] = useState(false);

  // Confirmations of things that cannot be taken back ignore a stray second tap.
  const cardConfirmArmed = useArmed(!!cardSheet && cardSheet.step !== 'choose');
  const exchangeAskArmed = useArmed(showExchangeAsk);
  const leaveArmed = useArmed(showLeave);

  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressedCard = useRef<number | null>(null);

  const { players } = gameState;
  const me = isSpectator ? undefined : players.find(p => p.id === gameState.myId);
  const current: ClientPlayerState | undefined = players[gameState.currentPlayerIndex];
  const over = gameState.turnPhase === TurnPhase.GameOver || gameState.status === GameStatus.Finished;
  const exchanging = gameState.turnPhase === TurnPhase.AwaitingExchange;
  const myTurn = !over && !!me && me.isAlive && current?.id === me.id;
  const canRecord = myTurn && !exchanging;
  const canUndo = !over && !!me && gameState.tableUndoPlayerId === me.id;
  const winner = over ? players.find(p => p.id === gameState.winnerId) : undefined;
  const exchange = gameState.exchangeState;
  const canPassFor = isHost && !over && !!current && current.id !== me?.id;

  // Everyone else, clockwise from the seat on your left, so the screen matches the table.
  const others = useMemo(() => {
    const myIndex = me ? players.findIndex(p => p.id === me.id) : -1;
    if (myIndex < 0) return players;
    return players.map((_, i) => players[(myIndex + 1 + i) % players.length]).filter(p => p.id !== me?.id);
  }, [players, me]);

  const awayIds = useMemo(
    () => new Set(roomPlayers.filter(p => !p.isBot && !p.connected).map(p => p.id)),
    [roomPlayers],
  );

  // A fresh exchange starts with nothing chosen.
  const exchangeKey = exchange ? exchange.availableCards.join(',') : '';
  useEffect(() => { setKeep([]); }, [exchangeKey]);

  // Close what no longer applies when the turn or the game moves on.
  useEffect(() => { if (!canRecord) { setShowSteal(false); setShowExchangeAsk(false); } }, [canRecord]);
  useEffect(() => {
    if (over) { setCardSheet(null); setShowCorrect(false); setShowLeave(false); setShowMore(false); }
  }, [over]);

  // One tap, one entry: the buttons come back when the server has answered.
  const logLength = gameState.actionLog.length;
  useEffect(() => { setEntryLocked(false); }, [logLength]);
  useEffect(() => {
    if (!entryLocked) return;
    const timer = setTimeout(() => setEntryLocked(false), ENTRY_LOCK_MS);
    return () => clearTimeout(timer);
  }, [entryLocked]);

  // A buzz when the turn comes round, so nobody has to watch the screen.
  useEffect(() => { if (myTurn) haptic(120); }, [myTurn]);

  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);

  // Keep the phone awake at the table: a sleeping phone drops its connection.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (!wakeLock || document.visibilityState !== 'visible') return;
        const acquired = await wakeLock.request('screen');
        if (cancelled) void acquired.release(); else lock = acquired;
      } catch {
        // Not supported or refused (low battery): the game still works.
      }
    };
    void request();
    const onVisible = () => { if (document.visibilityState === 'visible') void request(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, []);

  const record = (action: TableAction, targetId?: string) => {
    if (entryLocked) return;
    haptic(60);
    setEntryLocked(true);
    socket.emit('table:action', targetId ? { action, targetId } : { action });
  };

  const pass = () => {
    if (entryLocked) return;
    haptic(60);
    setEntryLocked(true);
    socket.emit('table:pass');
  };

  // Your own card: a short press opens its options, a longer one looks at it.
  const startPress = (index: number) => {
    pressedCard.current = index;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => { pressTimer.current = null; setPeekIndex(index); }, PEEK_HOLD_MS);
  };
  const endPress = (index: number, released: boolean) => {
    const wasShort = pressTimer.current !== null;
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    setPeekIndex(null);
    if (released && wasShort && pressedCard.current === index && !over && !exchange) {
      haptic();
      setCardSheet({ index, step: 'choose' });
    }
    pressedCard.current = null;
  };

  const confirmCard = () => {
    if (!cardSheet || cardSheet.step === 'choose') return;
    hapticHeavy();
    socket.emit(cardSheet.step === 'lose' ? 'table:lose_influence' : 'table:prove_influence', { influenceIndex: cardSheet.index });
    setCardSheet(null);
  };

  const toggleKeep = (index: number) => {
    if (!exchange) return;
    haptic();
    setKeep(k => k.includes(index)
      ? k.filter(i => i !== index)
      : k.length < exchange.keepCount ? [...k, index] : k);
  };

  const status = over
    ? null
    : exchanging
      ? (myTurn ? t('game.table.exchangingYou') : t('game.table.exchangingOther', { name: current?.name ?? '' }))
      : myTurn ? t('game.table.yourTurn') : t('game.table.turnOf', { name: current?.name ?? '' });

  const latest = gameState.actionLog[gameState.actionLog.length - 1];
  const sheetInfluence = cardSheet && me ? me.influences[cardSheet.index] : undefined;
  const sheetCharacter = sheetInfluence && !sheetInfluence.revealed ? sheetInfluence.character : null;
  const hasHiddenCard = !!me && me.influences.some(inf => !inf.revealed);

  // What a turn can come to, most common first. Payments sit on their own row, away from the gains.
  const gains: Array<{ action: TableAction; sub: string }> = [
    { action: ActionType.Income, sub: t('game.table.gain', { count: INCOME_COINS }) },
    { action: ActionType.ForeignAid, sub: t('game.table.gain', { count: FOREIGN_AID_COINS }) },
    { action: ActionType.Tax, sub: t('game.table.gain', { count: TAX_COINS }) },
  ];
  const entryClass = 'min-h-14 !px-1 !py-2 flex flex-col items-center justify-center leading-tight';

  return (
    <div className="min-h-dvh flex flex-col text-coup-ink select-none touch-manipulation overscroll-none">
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="menu-label">{t('game.table.title')} · <span className="figure">{gameState.roomCode}</span></p>
          <p className="text-sm text-coup-ink-mute">{t('game.table.deck', { count: gameState.deckCount })}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-sm px-3 py-2" onClick={() => { haptic(); setShowLog(true); }}>
            {t('game.table.log')}
          </button>
          <button type="button" className="btn-secondary text-sm px-3 py-2" onClick={() => { haptic(); setShowMore(true); }}>
            {t('game.table.more')}
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-3 pb-6 flex flex-col gap-3">
        {/* Everyone else, clockwise from your left. Kept small so your own
            cards and the entry buttons stay on a phone screen with six players. */}
        <section aria-label={t('lobby.players')}>
          <ul className={`grid gap-2 ${others.length <= 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {others.map(p => {
              const isCurrent = !over && current?.id === p.id;
              const note = !p.isAlive ? t('game.table.out') : awayIds.has(p.id) ? t('game.table.away') : null;
              return (
                <li
                  key={p.id}
                  className={`menu-panel !p-2 flex flex-col gap-1 min-w-0 ${isCurrent ? 'ring-2 ring-coup-accent' : ''} ${p.isAlive ? '' : 'opacity-50'}`}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <p className="truncate text-sm font-semibold">
                    <span className="figure text-coup-ink-mute me-1">{t.number(p.seatIndex + 1)}</span>
                    <bdi>{p.name}</bdi>
                  </p>
                  <p className="flex items-center justify-between gap-1 text-sm">
                    <span className="flex items-center gap-1 figure text-coup-gold" aria-label={t('game.table.coins', { count: p.coins })}>
                      <CoinIcon size={14} />{t.number(p.coins)}
                    </span>
                    {note && <span className="text-xs text-coup-ink-mute">{note}</span>}
                  </p>
                  <ul className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    {p.influences.map((inf, i) => (
                      <li key={i} className="flex items-center gap-1 h-5">
                        {inf.character
                          ? <LogCharacter character={inf.character} t={t} />
                          : <><CardBack size={16} /><span className="sr-only">{t('game.card.hidden')}</span></>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Whose turn, the last thing recorded, and one tap to take your own entry back */}
        <section className="menu-panel !p-3" aria-live="polite">
          {over ? (
            <div className="flex flex-col gap-3 text-center">
              <p className="text-xl font-bold text-coup-accent">
                {winner && winner.id === me?.id ? t('game.table.winnerYou') : t('game.table.winnerOther', { name: winner?.name ?? '' })}
              </p>
              {isHost
                ? <button type="button" className="btn-primary" onClick={() => { haptic(80); onRematch(); }}>{t('game.table.backToLobby')}</button>
                : <p className="text-coup-ink-mute">{t('game.table.waitingHost')}</p>}
            </div>
          ) : (
            <p className={`text-lg font-semibold ${myTurn ? 'text-coup-accent' : ''}`}>{status}</p>
          )}
          {latest && (
            <div className="mt-1 flex items-center gap-2 text-sm min-h-10">
              <LogStamp entry={latest} />
              <span className="min-w-0 flex-1">{renderLogText(latest, logContext)}</span>
              {canUndo && (
                <button type="button" className="btn-secondary text-sm px-3 py-2 shrink-0" onClick={() => { haptic(); socket.emit('table:undo'); }}>
                  {t('game.table.undo')}
                </button>
              )}
            </div>
          )}
        </section>

        {/* You */}
        {me && (
          <section className="menu-panel !p-3 flex flex-col gap-2" aria-label={t('game.table.yourCards')}>
            <div className="flex items-center justify-between">
              <p className="font-semibold min-w-0 truncate">
                <span className="figure text-coup-ink-mute me-1">{t.number(me.seatIndex + 1)}</span>
                <bdi>{me.name}</bdi>
              </p>
              <p className="flex items-center gap-2 text-2xl figure text-coup-gold shrink-0" aria-label={t('game.table.coins', { count: me.coins })}>
                <CoinIcon size={22} />{t.number(me.coins)}
              </p>
            </div>

            <div className="flex justify-center gap-6">
              {me.influences.map((inf, i) => (
                inf.revealed || over ? (
                  <CardFace key={i} influence={inf} size="lg" disablePreview />
                ) : (
                  <div
                    key={i}
                    role="button"
                    tabIndex={0}
                    aria-label={t('game.table.cardLabel')}
                    className="touch-none cursor-pointer"
                    style={{ WebkitTouchCallout: 'none' }}
                    onPointerDown={() => startPress(i)}
                    onPointerUp={() => endPress(i, true)}
                    onPointerLeave={() => endPress(i, false)}
                    onPointerCancel={() => endPress(i, false)}
                    onContextMenu={e => e.preventDefault()}
                    onKeyDown={e => {
                      if ((e.key === ' ' || e.key === 'Enter') && !exchange) { e.preventDefault(); setCardSheet({ index: i, step: 'choose' }); }
                    }}
                  >
                    <div className="pointer-events-none">
                      {peekIndex === i
                        ? <CardFace key="face" influence={inf} size="lg" disablePreview />
                        : <CardFace key="back" influence={HIDDEN_CARD} size="lg" disablePreview />}
                    </div>
                  </div>
                )
              ))}
            </div>

            {hasHiddenCard && !over && <p className="text-center text-xs text-coup-ink-mute">{t('game.table.cardHelp')}</p>}
            {!me.isAlive && !over && <p className="text-center text-coup-ink-mute">{t('game.table.youAreOut')}</p>}

            {/* The entry buttons exist only on your turn */}
            {canRecord && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-3">
                  {gains.map(({ action, sub }) => (
                    <button key={action} type="button" className={`btn-primary ${entryClass}`} disabled={entryLocked} onClick={() => record(action)}>
                      <span className="font-semibold">{actionName(t, action)}</span>
                      <span className="text-sm figure opacity-80">{sub}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`btn-primary ${entryClass}`}
                    disabled={entryLocked || !others.some(p => p.isAlive && p.coins > 0)}
                    onClick={() => { haptic(); setShowSteal(true); }}
                  >
                    <span className="font-semibold">{actionName(t, ActionType.Steal)}</span>
                    <span className="text-sm figure opacity-80">{t('game.table.take', { count: STEAL_COINS })}</span>
                  </button>
                  <button type="button" className={`btn-primary ${entryClass}`} disabled={entryLocked} onClick={() => { haptic(); setShowExchangeAsk(true); }}>
                    <span className="font-semibold">{actionName(t, ActionType.Exchange)}</span>
                    <span className="text-sm figure opacity-80">{t('game.table.draw', { count: EXCHANGE_DRAW_COUNT })}</span>
                  </button>
                  <button type="button" className={`btn-secondary ${entryClass}`} disabled={entryLocked} onClick={pass}>
                    <span className="font-semibold">{t('game.table.pass')}</span>
                    <span className="text-sm opacity-80">{t('game.table.passSub')}</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" className={`btn-secondary ${entryClass}`} disabled={entryLocked || me.coins < ASSASSINATE_COST} onClick={() => record(ActionType.Assassinate)}>
                    <span className="font-semibold">{actionName(t, ActionType.Assassinate)}</span>
                    <span className="text-sm figure opacity-80">{t('game.table.pay', { count: ASSASSINATE_COST })}</span>
                  </button>
                  <button type="button" className={`btn-secondary ${entryClass}`} disabled={entryLocked || me.coins < COUP_COST} onClick={() => record(ActionType.Coup)}>
                    <span className="font-semibold">{actionName(t, ActionType.Coup)}</span>
                    <span className="text-sm figure opacity-80">{t('game.table.pay', { count: COUP_COST })}</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Your card: what to do with it, then a confirmation, because neither can be taken back */}
      <Modal
        open={!!cardSheet && !!sheetCharacter}
        onClose={() => setCardSheet(null)}
        title={sheetCharacter
          ? cardSheet?.step === 'lose' ? t('game.table.loseTitle', { character: characterName(t, sheetCharacter) })
            : cardSheet?.step === 'show' ? t('game.table.showTitle', { character: characterName(t, sheetCharacter) })
              : characterName(t, sheetCharacter)
          : undefined}
      >
        {cardSheet && sheetInfluence && (
          cardSheet.step === 'choose' ? (
            <div className="flex flex-col gap-3">
              <div className="flex justify-center"><CardFace influence={sheetInfluence} size="lg" disablePreview /></div>
              <button type="button" className="btn-secondary w-full min-h-14" onClick={() => { haptic(); setCardSheet({ ...cardSheet, step: 'lose' }); }}>
                {t('game.table.loseOption')}
              </button>
              <button type="button" className="btn-secondary w-full min-h-14" onClick={() => { haptic(); setCardSheet({ ...cardSheet, step: 'show' }); }}>
                {t('game.table.showOption')}
              </button>
              <button type="button" className="btn-primary w-full min-h-14 mt-3" onClick={() => setCardSheet(null)}>{t('common.cancel')}</button>
            </div>
          ) : (
            <>
              <p className="text-sm text-coup-ink-mute mb-4">{t(cardSheet.step === 'lose' ? 'game.table.loseBody' : 'game.table.showBody')}</p>
              <div className="flex gap-3">
                <button type="button" className="btn-secondary flex-1 min-h-14" onClick={() => setCardSheet({ ...cardSheet, step: 'choose' })}>{t('common.back')}</button>
                <button type="button" className="btn-danger flex-1 min-h-14" disabled={!cardConfirmArmed} onClick={confirmCard}>
                  {t(cardSheet.step === 'lose' ? 'game.table.lose' : 'game.table.show')}
                </button>
              </div>
            </>
          )
        )}
      </Modal>

      {/* Steal: from whom */}
      <Modal open={showSteal && canRecord} onClose={() => setShowSteal(false)} title={t('game.table.stealTitle')}>
        <ul className="flex flex-col gap-3 mb-4">
          {others.filter(p => p.isAlive).map(p => (
            <li key={p.id}>
              <button
                type="button"
                className="btn-secondary w-full min-h-14 flex items-center justify-between gap-3"
                disabled={p.coins === 0 || entryLocked}
                onClick={() => { setShowSteal(false); record(ActionType.Steal, p.id); }}
              >
                <bdi className="min-w-0 truncate">{p.name}</bdi>
                <span className="flex items-center gap-1 figure text-coup-gold"><CoinIcon size={14} />{t.number(p.coins)}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-primary w-full min-h-14" onClick={() => setShowSteal(false)}>{t('common.cancel')}</button>
      </Modal>

      {/* Exchange draws cards you then know, so it asks first */}
      <Modal open={showExchangeAsk && canRecord} onClose={() => setShowExchangeAsk(false)} title={actionName(t, ActionType.Exchange)}>
        <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.exchangeAsk')}</p>
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1 min-h-14" onClick={() => setShowExchangeAsk(false)}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary flex-1 min-h-14" disabled={entryLocked || !exchangeAskArmed} onClick={() => { setShowExchangeAsk(false); record(ActionType.Exchange); }}>
            {t('game.table.draw', { count: EXCHANGE_DRAW_COUNT })}
          </button>
        </div>
      </Modal>

      {/* Exchange: choose what to keep. Only the exchanging player is sent this. */}
      <Modal open={!!exchange} title={exchange ? t('game.table.exchangeTitle', { count: exchange.keepCount }) : undefined}>
        {exchange && (
          <>
            <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.exchangeBody')}</p>
            <div className="grid grid-cols-2 gap-4 justify-items-center w-fit mx-auto mb-4">
              {exchange.availableCards.map((character, i) => (
                <CardFace
                  key={i}
                  influence={{ character, revealed: false }}
                  size="lg"
                  selected={keep.includes(i)}
                  onClick={() => toggleKeep(i)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn-primary w-full min-h-14"
              disabled={keep.length !== exchange.keepCount}
              onClick={() => { haptic(80); socket.emit('table:exchange', { keepIndices: keep }); }}
            >
              {t('game.table.exchangeConfirm')}
            </button>
          </>
        )}
      </Modal>

      {/* The rare things, away from the thumb */}
      <Modal open={showMore} onClose={() => setShowMore(false)} title={t('game.table.more')}>
        <div className="flex flex-col gap-3">
          {me?.isAlive && !over && (
            <button type="button" className="btn-secondary w-full min-h-14" onClick={() => { setShowMore(false); setShowCorrect(true); }}>
              {t('game.table.correct')}
            </button>
          )}
          {canPassFor && current && (
            <button type="button" className="btn-secondary w-full min-h-14" disabled={entryLocked} onClick={() => { setShowMore(false); pass(); }}>
              {t('game.table.passFor', { name: current.name })}
            </button>
          )}
          <button type="button" className="btn-secondary w-full min-h-14" onClick={() => { setShowMore(false); setShowSettings(true); }}>
            {t('common.settings')}
          </button>
          {onLeave && !over && (
            <button type="button" className="btn-secondary w-full min-h-14" onClick={() => { setShowMore(false); setShowLeave(true); }}>
              {t('game.table.leave')}
            </button>
          )}
          <button type="button" className="btn-primary w-full min-h-14 mt-3" onClick={() => setShowMore(false)}>{t('common.close')}</button>
        </div>
      </Modal>

      {/* Correct your own coins */}
      <Modal open={showCorrect && !!me} onClose={() => setShowCorrect(false)} title={t('game.table.correct')}>
        <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.correctBody')}</p>
        <p className="flex items-center justify-center gap-2 text-3xl figure text-coup-gold mb-4">
          <CoinIcon size={26} />{t.number(me?.coins ?? 0)}
        </p>
        <div className="flex gap-3 mb-3">
          <button type="button" className="btn-secondary flex-1 min-h-14" disabled={(me?.coins ?? 0) < 1} onClick={() => { haptic(); socket.emit('table:adjust_coins', { delta: -1 }); }}>
            {t('game.table.removeCoin')}
          </button>
          <button type="button" className="btn-secondary flex-1 min-h-14" onClick={() => { haptic(); socket.emit('table:adjust_coins', { delta: 1 }); }}>
            {t('game.table.addCoin')}
          </button>
        </div>
        <button type="button" className="btn-primary w-full min-h-14" onClick={() => setShowCorrect(false)}>{t('common.done')}</button>
      </Modal>

      {/* The whole log, newest first */}
      <Modal open={showLog} onClose={() => setShowLog(false)} title={t('game.table.log')}>
        {gameState.actionLog.length === 0 ? (
          <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.logEmpty')}</p>
        ) : (
          <ol className="flex flex-col gap-2 mb-4">
            {[...gameState.actionLog].reverse().map((entry, i) => (
              <li key={`${entry.timestamp}-${i}`} className="flex items-start gap-2 text-sm">
                <LogStamp entry={entry} />
                <span className="min-w-0">{renderLogText(entry, logContext)}</span>
              </li>
            ))}
          </ol>
        )}
        <button type="button" className="btn-primary w-full min-h-14" onClick={() => setShowLog(false)}>{t('common.close')}</button>
      </Modal>

      {/* Leave for good */}
      <Modal open={showLeave} onClose={() => setShowLeave(false)} title={t('game.table.leave')}>
        <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.leaveBody')}</p>
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1 min-h-14" onClick={() => setShowLeave(false)}>{t('common.cancel')}</button>
          <button type="button" className="btn-danger flex-1 min-h-14" disabled={!leaveArmed} onClick={() => { setShowLeave(false); onLeave?.(); }}>{t('game.table.leave')}</button>
        </div>
      </Modal>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}
