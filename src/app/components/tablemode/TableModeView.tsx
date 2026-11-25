'use client';

import { useEffect, useMemo, useState } from 'react';
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

type CardPrompt = { kind: 'lose' | 'show'; index: number };

const HIDDEN_CARD = { character: null, revealed: false } as const;

/**
 * Table mode: the screen for playing in person.
 *
 * The phone is the deck, your hand and the coins. Claims, challenges and
 * blocks are said out loud; whoever an outcome belongs to records it here
 * with one tap. Your cards stay face down until you hold one, because the
 * people you are bluffing sit next to you.
 */
export function TableModeView({ gameState, isHost, isSpectator, onRematch, onLeave }: TableModeViewProps) {
  const t = useT();
  const socket = getSocket();
  const roomPlayers = useGameStore(s => s.roomPlayers);
  const logContext = useLogContext(gameState.players);

  const [peekIndex, setPeekIndex] = useState<number | null>(null);
  const [cardPrompt, setCardPrompt] = useState<CardPrompt | null>(null);
  const [showSteal, setShowSteal] = useState(false);
  const [showCorrect, setShowCorrect] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [keep, setKeep] = useState<number[]>([]);

  const { players } = gameState;
  const me = isSpectator ? undefined : players.find(p => p.id === gameState.myId);
  const current: ClientPlayerState | undefined = players[gameState.currentPlayerIndex];
  const over = gameState.turnPhase === TurnPhase.GameOver || gameState.status === GameStatus.Finished;
  const exchanging = gameState.turnPhase === TurnPhase.AwaitingExchange;
  const myTurn = !over && !!me && me.isAlive && current?.id === me.id;
  const canRecord = myTurn && !exchanging;
  const winner = over ? players.find(p => p.id === gameState.winnerId) : undefined;
  const exchange = gameState.exchangeState;

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
  useEffect(() => { if (!canRecord) setShowSteal(false); }, [canRecord]);
  useEffect(() => { if (over) { setCardPrompt(null); setShowCorrect(false); setShowLeave(false); } }, [over]);

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
    haptic(60);
    socket.emit('table:action', targetId ? { action, targetId } : { action });
  };

  const confirmCard = () => {
    if (!cardPrompt) return;
    hapticHeavy();
    socket.emit(cardPrompt.kind === 'lose' ? 'table:lose_influence' : 'table:prove_influence', { influenceIndex: cardPrompt.index });
    setCardPrompt(null);
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
  const promptCharacter = cardPrompt && me ? me.influences[cardPrompt.index]?.character : null;

  const actions: Array<{ action: TableAction; sub: string; disabled?: boolean; onPick?: () => void }> = me ? [
    { action: ActionType.Income, sub: t('game.table.gain', { count: INCOME_COINS }) },
    { action: ActionType.ForeignAid, sub: t('game.table.gain', { count: FOREIGN_AID_COINS }) },
    { action: ActionType.Tax, sub: t('game.table.gain', { count: TAX_COINS }) },
    {
      action: ActionType.Steal,
      sub: t('game.table.take', { count: STEAL_COINS }),
      disabled: !others.some(p => p.isAlive && p.coins > 0),
      onPick: () => { haptic(); setShowSteal(true); },
    },
    { action: ActionType.Assassinate, sub: t('game.table.pay', { count: ASSASSINATE_COST }), disabled: me.coins < ASSASSINATE_COST },
    { action: ActionType.Coup, sub: t('game.table.pay', { count: COUP_COST }), disabled: me.coins < COUP_COST },
    { action: ActionType.Exchange, sub: t('game.table.draw', { count: EXCHANGE_DRAW_COUNT }) },
  ] : [];

  return (
    <div className="min-h-dvh flex flex-col text-coup-ink">
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="menu-label">{t('game.table.title')} · <span className="figure">{gameState.roomCode}</span></p>
          <p className="text-sm text-coup-ink-mute">{t('game.table.deck', { count: gameState.deckCount })}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-sm px-3 py-2" onClick={() => { haptic(); setShowLog(true); }}>
            {t('game.table.log')}
          </button>
          <button type="button" className="btn-secondary text-sm px-3 py-2" onClick={() => { haptic(); setShowSettings(true); }}>
            {t('common.settings')}
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

        {/* Whose turn, and the last thing recorded */}
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
            <>
              <p className={`font-semibold ${myTurn ? 'text-coup-accent' : ''}`}>{status}</p>
              {myTurn && !exchanging && <p className="text-sm text-coup-ink-mute">{t('game.table.hint')}</p>}
            </>
          )}
          {latest && (
            <p className="mt-2 flex items-center gap-2 text-sm">
              <LogStamp entry={latest} />
              <span className="min-w-0">{renderLogText(latest, logContext)}</span>
            </p>
          )}
        </section>

        {/* You */}
        {me && (
          <section className="menu-panel !p-3 flex flex-col gap-3" aria-label={t('game.table.yourCards')}>
            <div className="flex items-center justify-between">
              <p className="font-semibold">
                <span className="figure text-coup-ink-mute me-1">{t.number(me.seatIndex + 1)}</span>
                <bdi>{me.name}</bdi>
              </p>
              <p className="flex items-center gap-2 text-2xl figure text-coup-gold" aria-label={t('game.table.coins', { count: me.coins })}>
                <CoinIcon size={22} />{t.number(me.coins)}
              </p>
            </div>

            <div className="flex justify-center gap-4">
              {me.influences.map((inf, i) => (
                <div key={i} className="flex flex-col items-center gap-2">
                  {inf.revealed || over ? (
                    <CardFace influence={inf} size="lg" disablePreview />
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={t('game.table.peekLabel')}
                      className="select-none touch-none cursor-pointer"
                      onPointerDown={() => setPeekIndex(i)}
                      onPointerUp={() => setPeekIndex(null)}
                      onPointerLeave={() => setPeekIndex(null)}
                      onPointerCancel={() => setPeekIndex(null)}
                      onContextMenu={e => e.preventDefault()}
                      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setPeekIndex(i); } }}
                      onKeyUp={() => setPeekIndex(null)}
                      onBlur={() => setPeekIndex(null)}
                    >
                      <div className="pointer-events-none">
                        {peekIndex === i
                          ? <CardFace key="face" influence={inf} size="lg" disablePreview />
                          : <CardFace key="back" influence={HIDDEN_CARD} size="lg" disablePreview />}
                      </div>
                    </div>
                  )}
                  {!inf.revealed && !over && (
                    <>
                      <p className="text-xs text-coup-ink-mute">{t('game.table.peek')}</p>
                      <div className="flex gap-2">
                        <button type="button" className="btn-secondary text-sm px-3 py-2" disabled={!!exchange} onClick={() => { haptic(); setCardPrompt({ kind: 'lose', index: i }); }}>
                          {t('game.table.lose')}
                        </button>
                        <button type="button" className="btn-secondary text-sm px-3 py-2" disabled={!!exchange} onClick={() => { haptic(); setCardPrompt({ kind: 'show', index: i }); }}>
                          {t('game.table.show')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            {!me.isAlive && !over && <p className="text-center text-coup-ink-mute">{t('game.table.youAreOut')}</p>}

            {me.isAlive && !over && (
              <>
                <div className="grid grid-cols-4 gap-2">
                  {actions.map(({ action, sub, disabled, onPick }) => (
                    <button
                      key={action}
                      type="button"
                      className="btn-primary !px-1 !py-2 flex flex-col items-center leading-tight"
                      disabled={!canRecord || disabled}
                      onClick={onPick ?? (() => record(action))}
                    >
                      <span className="text-sm font-semibold">{actionName(t, action)}</span>
                      <span className="text-xs figure opacity-80">{sub}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn-secondary !px-1 !py-2 flex flex-col items-center leading-tight"
                    disabled={!canRecord}
                    onClick={() => { haptic(60); socket.emit('table:pass'); }}
                  >
                    <span className="text-sm font-semibold">{t('game.table.pass')}</span>
                    <span className="text-xs opacity-80">{t('game.table.passSub')}</span>
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-sm px-3 py-2"
                    disabled={gameState.tableUndoPlayerId !== me.id}
                    onClick={() => { haptic(); socket.emit('table:undo'); }}
                  >
                    {t('game.table.undo')}
                  </button>
                  <button type="button" className="btn-secondary text-sm px-3 py-2" onClick={() => { haptic(); setShowCorrect(true); }}>
                    {t('game.table.correct')}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* Host: move the game on for a player whose phone is away */}
        {isHost && !over && current && current.id !== me?.id && (
          <button type="button" className="btn-secondary text-sm" onClick={() => { haptic(); socket.emit('table:pass'); }}>
            {t('game.table.passFor', { name: current.name })}
          </button>
        )}

        {onLeave && !over && (
          <button type="button" className="text-sm text-coup-ink-mute underline self-center" onClick={() => { haptic(); setShowLeave(true); }}>
            {t('game.table.leave')}
          </button>
        )}
      </main>

      {/* Lose or show one of your cards */}
      <Modal
        open={!!cardPrompt && !!promptCharacter}
        onClose={() => setCardPrompt(null)}
        title={promptCharacter ? t(cardPrompt?.kind === 'lose' ? 'game.table.loseTitle' : 'game.table.showTitle', { character: characterName(t, promptCharacter) }) : undefined}
      >
        <p className="text-sm text-coup-ink-mute mb-4">{t(cardPrompt?.kind === 'lose' ? 'game.table.loseBody' : 'game.table.showBody')}</p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={() => setCardPrompt(null)}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary flex-1" onClick={confirmCard}>
            {t(cardPrompt?.kind === 'lose' ? 'game.table.lose' : 'game.table.show')}
          </button>
        </div>
      </Modal>

      {/* Steal: from whom */}
      <Modal open={showSteal && canRecord} onClose={() => setShowSteal(false)} title={t('game.table.stealTitle')}>
        <ul className="flex flex-col gap-2 mb-4">
          {others.filter(p => p.isAlive).map(p => (
            <li key={p.id}>
              <button
                type="button"
                className="btn-secondary w-full flex items-center justify-between gap-3"
                disabled={p.coins === 0}
                onClick={() => { setShowSteal(false); record(ActionType.Steal, p.id); }}
              >
                <bdi className="min-w-0 truncate">{p.name}</bdi>
                <span className="flex items-center gap-1 figure text-coup-gold"><CoinIcon size={14} />{t.number(p.coins)}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-secondary w-full" onClick={() => setShowSteal(false)}>{t('common.cancel')}</button>
      </Modal>

      {/* Exchange: choose what to keep. Only the exchanging player is sent this. */}
      <Modal open={!!exchange} title={exchange ? t('game.table.exchangeTitle', { count: exchange.keepCount }) : undefined}>
        {exchange && (
          <>
            <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.exchangeBody')}</p>
            <div className="flex flex-wrap justify-center gap-3 mb-4">
              {exchange.availableCards.map((character, i) => (
                <CardFace
                  key={i}
                  influence={{ character, revealed: false }}
                  size="md"
                  selected={keep.includes(i)}
                  onClick={() => toggleKeep(i)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn-primary w-full"
              disabled={keep.length !== exchange.keepCount}
              onClick={() => { haptic(80); socket.emit('table:exchange', { keepIndices: keep }); }}
            >
              {t('game.table.exchangeConfirm')}
            </button>
          </>
        )}
      </Modal>

      {/* Correct your own coins */}
      <Modal open={showCorrect && !!me} onClose={() => setShowCorrect(false)} title={t('game.table.correct')}>
        <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.correctBody')}</p>
        <p className="flex items-center justify-center gap-2 text-3xl figure text-coup-gold mb-4">
          <CoinIcon size={26} />{t.number(me?.coins ?? 0)}
        </p>
        <div className="flex gap-2 mb-2">
          <button type="button" className="btn-secondary flex-1" disabled={(me?.coins ?? 0) < 1} onClick={() => { haptic(); socket.emit('table:adjust_coins', { delta: -1 }); }}>
            {t('game.table.removeCoin')}
          </button>
          <button type="button" className="btn-secondary flex-1" onClick={() => { haptic(); socket.emit('table:adjust_coins', { delta: 1 }); }}>
            {t('game.table.addCoin')}
          </button>
        </div>
        <button type="button" className="btn-primary w-full" onClick={() => setShowCorrect(false)}>{t('common.done')}</button>
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
        <button type="button" className="btn-secondary w-full" onClick={() => setShowLog(false)}>{t('common.close')}</button>
      </Modal>

      {/* Leave for good */}
      <Modal open={showLeave} onClose={() => setShowLeave(false)} title={t('game.table.leave')}>
        <p className="text-sm text-coup-ink-mute mb-4">{t('game.table.leaveBody')}</p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={() => setShowLeave(false)}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary flex-1" onClick={() => { setShowLeave(false); onLeave?.(); }}>{t('game.table.leave')}</button>
        </div>
      </Modal>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}
