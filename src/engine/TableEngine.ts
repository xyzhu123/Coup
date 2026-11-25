import {
  ActionType,
  GameMode,
  GameState,
  GameStatus,
  TABLE_ACTIONS,
  TableAction,
  TurnPhase,
} from '../shared/types';
import {
  ASSASSINATE_COST,
  COUP_COST,
  EXCHANGE_DRAW_COUNT,
  FOREIGN_AID_COINS,
  INCOME_COINS,
  STEAL_COINS,
  TAX_COINS,
} from '../shared/constants';
import { logMsg } from '../shared/i18n/logMessages';
import { GameEngine } from './GameEngine';
import type { Player } from './Player';

/** What a coin entry looked like before it was made, so its author can take it back. */
interface UndoSnapshot {
  playerId: string;
  coins: Map<string, number>;
  treasury: number;
  currentPlayerIndex: number;
  turnNumber: number;
}

const coins = (n: number): string => `${n} coin${n === 1 ? '' : 's'}`;

/**
 * Table mode: the engine for playing in person.
 *
 * The app is only the deck, the hands and the coins. Players say their claims,
 * challenges and blocks out loud and settle them at the table; afterwards
 * whoever the outcome belongs to records it with one entry. So there are no
 * challenge or block windows, no timers and no bots here, and the engine does
 * not judge whether a claim was allowed. It enforces only what keeps the
 * books straight: you record on your own turn, you touch only your own cards,
 * and you cannot spend coins you do not have.
 *
 * Classic rules only. The turn marker moves on after every turn-ending entry
 * (or a pass, when the action came to nothing). Losing a card, showing a card
 * to win a challenge and correcting coins can happen at any time.
 */
export class TableEngine extends GameEngine {
  private undoSnapshot: UndoSnapshot | null = null;

  constructor(roomCode: string) {
    // No challenge window and no turn timer.
    super(roomCode, 0, 0);
  }

  override startGame(
    playerInfos: Array<{ id: string; name: string }>,
    options?: { gameMode?: GameMode; useInquisitor?: boolean; firstPlayerId?: string | null },
  ): void {
    const chosen = playerInfos.findIndex(p => p.id === options?.firstPlayerId);
    this.game.initialize(playerInfos, {
      gameMode: GameMode.Classic,
      useInquisitor: false,
      firstPlayerIndex: chosen >= 0 ? chosen : 0,
    });
    this.exchangeState = null;
    this.undoSnapshot = null;
    this.broadcastState();
  }

  override getFullState(): GameState {
    const state = super.getFullState();
    state.tableMode = true;
    state.tableUndoPlayerId = this.undoSnapshot?.playerId ?? null;
    return state;
  }

  // ─── Turn-ending entries ───

  /** Record the outcome of the current player's turn. */
  tableAction(playerId: string, action: TableAction, targetId?: string): string | null {
    const player = this.livePlayer(playerId);
    if (typeof player === 'string') return player;
    if (this.exchangeState) {
      return this.exchangeState.playerId === playerId ? 'Finish your exchange first' : 'Not your turn';
    }
    if (this.game.currentPlayer.id !== playerId) return 'Not your turn';
    if (!(TABLE_ACTIONS as readonly ActionType[]).includes(action)) return 'Invalid action';

    const game = this.game;
    const snapshot = this.snapshot(playerId);

    switch (action) {
      case ActionType.Income: {
        const amount = Math.min(INCOME_COINS, game.treasury);
        game.giveCoins(player, amount);
        game.log({
          message: `${player.name} takes Income (+${coins(amount)}).`,
          msg: logMsg('income', { actor: playerId, amount }),
          eventType: 'income', actorId: playerId, actorName: player.name,
        });
        break;
      }
      case ActionType.ForeignAid: {
        const amount = Math.min(FOREIGN_AID_COINS, game.treasury);
        game.giveCoins(player, amount);
        game.log({
          message: `${player.name} takes Foreign Aid (+${coins(amount)}).`,
          msg: logMsg('foreignAidTaken', { actor: playerId, amount }),
          eventType: 'action_resolve', actorId: playerId, actorName: player.name,
        });
        break;
      }
      case ActionType.Tax: {
        const amount = Math.min(TAX_COINS, game.treasury);
        game.giveCoins(player, amount);
        game.log({
          message: `${player.name} collects Tax (+${coins(amount)}).`,
          msg: logMsg('taxCollected', { actor: playerId, amount }),
          eventType: 'action_resolve', actorId: playerId, actorName: player.name,
        });
        break;
      }
      case ActionType.Steal: {
        if (!targetId) return 'This action requires a target';
        const target = game.getPlayer(targetId);
        if (!target || !target.isAlive) return 'Target not found or eliminated';
        if (target.id === playerId) return 'Cannot target yourself';
        if (target.coins === 0) return 'Target has no coins to steal';
        const amount = Math.min(STEAL_COINS, target.coins);
        target.removeCoins(amount);
        player.addCoins(amount);
        game.log({
          message: `${player.name} steals ${coins(amount)} from ${target.name}.`,
          msg: logMsg('stealResolved', { actor: playerId, target: target.id, amount }),
          eventType: 'action_resolve', actorId: playerId, actorName: player.name, targetId: target.id,
        });
        break;
      }
      case ActionType.Assassinate: {
        if (player.coins < ASSASSINATE_COST) return `Not enough coins (need ${ASSASSINATE_COST}, have ${player.coins})`;
        game.takeCoins(player, ASSASSINATE_COST);
        game.log({
          message: `${player.name} pays ${coins(ASSASSINATE_COST)} to assassinate.`,
          msg: logMsg('tableAssassinatePaid', { actor: playerId, amount: ASSASSINATE_COST }),
          eventType: 'action_resolve', actorId: playerId, actorName: player.name,
        });
        break;
      }
      case ActionType.Coup: {
        if (player.coins < COUP_COST) return `Not enough coins (need ${COUP_COST}, have ${player.coins})`;
        game.takeCoins(player, COUP_COST);
        game.log({
          message: `${player.name} pays ${coins(COUP_COST)} for a Coup.`,
          msg: logMsg('tableCoupPaid', { actor: playerId, amount: COUP_COST }),
          eventType: 'action_resolve', actorId: playerId, actorName: player.name,
        });
        break;
      }
      case ActionType.Exchange: {
        const drawnCards = game.deck.drawMultiple(EXCHANGE_DRAW_COUNT);
        // Cards have been seen from here on, so nothing before this can be taken back.
        this.undoSnapshot = null;
        if (drawnCards.length === 0) {
          game.log({
            message: `${player.name} draws no cards. The deck is empty.`,
            msg: logMsg('exchangeDeckEmpty', { actor: playerId }),
            eventType: 'exchange', actorId: playerId, actorName: player.name,
          });
          this.advance();
        } else {
          this.exchangeState = { playerId, drawnCards };
          game.turnPhase = TurnPhase.AwaitingExchange;
          game.log({
            message: `${player.name} draws cards for exchange.`,
            msg: logMsg('exchangeDraw', { actor: playerId }),
            eventType: 'exchange_draw', actorId: playerId, actorName: player.name,
          });
        }
        this.broadcastState();
        return null;
      }
    }

    this.undoSnapshot = snapshot;
    this.advance();
    this.broadcastState();
    return null;
  }

  /**
   * End the current turn with nothing recorded (the action was blocked or lost
   * a challenge). The current player passes for themselves; the host may pass
   * for a player whose phone is away, which also abandons their open exchange.
   */
  tablePass(requesterId: string, requesterIsHost: boolean): string | null {
    const game = this.game;
    if (game.status !== GameStatus.InProgress) return 'No game in progress';
    const current = game.currentPlayer;
    const forSelf = requesterId === current.id;
    if (!forSelf && !requesterIsHost) return 'Not your turn';

    let snapshot: UndoSnapshot | null = this.snapshot(requesterId);
    if (this.exchangeState) {
      if (forSelf) return 'Finish your exchange first';
      game.deck.returnCards(this.exchangeState.drawnCards);
      game.deck.shuffle();
      this.exchangeState = null;
      snapshot = null;
    }

    game.log({
      message: `${current.name} ends the turn with no effect.`,
      msg: logMsg('tablePassed', { actor: current.id }),
      eventType: 'action_resolve', actorId: current.id, actorName: current.name,
    });
    this.undoSnapshot = snapshot;
    this.advance();
    this.broadcastState();
    return null;
  }

  /** Finish an Ambassador exchange: keep some cards, the rest go back into the deck. */
  tableExchange(playerId: string, keepIndices: number[]): string | null {
    if (!this.exchangeState) return 'No pending exchange';
    if (this.exchangeState.playerId !== playerId) return 'Not your exchange';
    const game = this.game;
    const player = game.getPlayer(playerId);
    if (!player) return 'Player not found';

    const hidden = player.influences.filter(inf => !inf.revealed);
    const available = [...hidden.map(inf => inf.character), ...this.exchangeState.drawnCards];
    const expectedKeep = hidden.length;
    if (!Array.isArray(keepIndices) || keepIndices.length !== expectedKeep) {
      return `Must keep exactly ${expectedKeep} card${expectedKeep === 1 ? '' : 's'}`;
    }
    if (keepIndices.some(i => !Number.isInteger(i) || i < 0 || i >= available.length)) return 'Invalid card index';
    if (new Set(keepIndices).size !== keepIndices.length) return 'Duplicate card indices';

    const kept = new Set(keepIndices);
    keepIndices.forEach((cardIndex, slot) => { hidden[slot].character = available[cardIndex]; });
    game.deck.returnCards(available.filter((_, i) => !kept.has(i)));
    game.deck.shuffle();
    this.exchangeState = null;
    this.undoSnapshot = null;

    game.log({
      message: `${player.name} completes the exchange.`,
      msg: logMsg('exchangeComplete', { actor: playerId }),
      eventType: 'exchange', actorId: playerId, actorName: player.name,
    });
    this.advance();
    this.broadcastState();
    return null;
  }

  // ─── Any time ───

  /** Turn one of your own cards face up for good (a lost challenge, an assassination, a Coup). */
  tableLoseInfluence(playerId: string, influenceIndex: number): string | null {
    const player = this.ownCard(playerId, influenceIndex);
    if (typeof player === 'string') return player;

    const character = player.influences[influenceIndex].character;
    player.revealInfluence(influenceIndex);
    this.undoSnapshot = null;
    this.game.log({
      message: `${player.name} loses ${character}.`,
      msg: logMsg('influenceLost', { actor: playerId, character }),
      eventType: 'influence_loss', character, actorId: playerId, actorName: player.name,
    });
    this.settle(player);
    this.broadcastState();
    return null;
  }

  /**
   * Show one of your own cards to the table to win a challenge. The card goes
   * back into the deck, the deck is shuffled, and you draw a replacement.
   */
  tableProveInfluence(playerId: string, influenceIndex: number): string | null {
    const player = this.ownCard(playerId, influenceIndex);
    if (typeof player === 'string') return player;

    const character = player.influences[influenceIndex].character;
    this.game.deck.returnAndShuffle(character);
    player.influences[influenceIndex].character = this.game.deck.draw() ?? character;
    this.undoSnapshot = null;
    this.game.log({
      message: `${player.name} shows ${character} and draws a replacement.`,
      msg: logMsg('tableProved', { actor: playerId, character }),
      eventType: 'challenge_fail', character, actorId: playerId, actorName: player.name,
    });
    this.broadcastState();
    return null;
  }

  /** Take back your own last coin entry, if nothing has been recorded since. */
  tableUndo(playerId: string): string | null {
    const game = this.game;
    if (game.status !== GameStatus.InProgress) return 'No game in progress';
    const snapshot = this.undoSnapshot;
    if (!snapshot || snapshot.playerId !== playerId) return 'Nothing to take back';

    for (const p of game.players) p.coins = snapshot.coins.get(p.id) ?? p.coins;
    game.treasury = snapshot.treasury;
    game.currentPlayerIndex = snapshot.currentPlayerIndex;
    game.turnNumber = snapshot.turnNumber;
    game.turnPhase = TurnPhase.AwaitingAction;
    this.undoSnapshot = null;

    const player = game.getPlayer(playerId);
    game.log({
      message: `${player?.name} takes back the last entry.`,
      msg: logMsg('tableUndone', { actor: playerId }),
      eventType: 'action_resolve', actorId: playerId, actorName: player?.name ?? null,
    });
    this.broadcastState();
    return null;
  }

  /** Correct your own coins by one, for anything the entries do not cover. */
  tableAdjustCoins(playerId: string, delta: number): string | null {
    const player = this.livePlayer(playerId);
    if (typeof player === 'string') return player;
    if (delta !== 1 && delta !== -1) return 'Invalid action';

    const game = this.game;
    if (delta === 1) {
      if (game.treasury < 1) return 'Invalid action';
      game.giveCoins(player, 1);
      game.log({
        message: `${player.name} adds ${coins(1)} as a correction.`,
        msg: logMsg('tableCoinsAdded', { actor: playerId, amount: 1 }),
        eventType: 'action_resolve', actorId: playerId, actorName: player.name,
      });
    } else {
      if (player.coins < 1) return `Not enough coins (need 1, have ${player.coins})`;
      game.takeCoins(player, 1);
      game.log({
        message: `${player.name} removes ${coins(1)} as a correction.`,
        msg: logMsg('tableCoinsRemoved', { actor: playerId, amount: 1 }),
        eventType: 'action_resolve', actorId: playerId, actorName: player.name,
      });
    }
    this.undoSnapshot = null;
    this.broadcastState();
    return null;
  }

  /**
   * A player changes the name on their seat, at any point in the game. The log
   * names players by id, so earlier lines follow the new name on every screen.
   */
  tableRename(playerId: string, name: string): string | null {
    const player = this.game.getPlayer(playerId);
    if (!player) return 'Player not found';
    player.name = name;
    this.broadcastState();
    return null;
  }

  /** A player walked away for good: their cards are turned up and they are out. */
  tableForfeit(playerId: string): boolean {
    const game = this.game;
    if (game.status !== GameStatus.InProgress) return false;
    const player = game.getPlayer(playerId);
    if (!player || !player.isAlive) return false;

    if (this.exchangeState?.playerId === playerId) {
      game.deck.returnCards(this.exchangeState.drawnCards);
      game.deck.shuffle();
      this.exchangeState = null;
      game.turnPhase = TurnPhase.AwaitingAction;
    }
    player.influences.forEach((_, i) => { player.revealInfluence(i); });
    this.undoSnapshot = null;
    game.log({
      message: `${player.name} left the table.`,
      msg: logMsg('tableLeft', { actor: playerId }),
      eventType: 'bot_replace', actorId: playerId, actorName: player.name,
    });
    this.settle(player);
    this.broadcastState();
    return true;
  }

  // ─── The online game's entry points do nothing here ───

  override handleAction(): string | null { return 'Invalid action'; }
  override handleChallenge(): string | null { return 'Invalid action'; }
  override handlePassChallenge(): string | null { return 'Invalid action'; }
  override handleBlock(): string | null { return 'Invalid action'; }
  override handlePassBlock(): string | null { return 'Invalid action'; }
  override handleChallengeBlock(): string | null { return 'Invalid action'; }
  override handlePassChallengeBlock(): string | null { return 'Invalid action'; }
  override handleChooseInfluenceLoss(): string | null { return 'Invalid action'; }
  override handleChooseExchange(): string | null { return 'Invalid action'; }
  override handleExamineDecision(): string | null { return 'Invalid action'; }
  override handleChooseExamineInfluence(): string | null { return 'Invalid action'; }
  override handleConvert(): string | null { return 'Invalid action'; }
  override handleEmbezzle(): string | null { return 'Invalid action'; }
  override handleTimerExpiry(): void { /* table mode has no timers */ }

  // ─── Internals ───

  private livePlayer(playerId: string): Player | string {
    if (this.game.status !== GameStatus.InProgress) return 'No game in progress';
    const player = this.game.getPlayer(playerId);
    if (!player) return 'Player not found';
    if (!player.isAlive) return 'You are eliminated';
    return player;
  }

  private ownCard(playerId: string, influenceIndex: number): Player | string {
    const player = this.livePlayer(playerId);
    if (typeof player === 'string') return player;
    if (this.exchangeState?.playerId === playerId) return 'Finish your exchange first';
    if (!Number.isInteger(influenceIndex) || influenceIndex < 0 || influenceIndex >= player.influences.length) {
      return 'Invalid influence index';
    }
    if (player.influences[influenceIndex].revealed) return 'That influence is already revealed';
    return player;
  }

  private snapshot(playerId: string): UndoSnapshot {
    const game = this.game;
    return {
      playerId,
      coins: new Map(game.players.map(p => [p.id, p.coins])),
      treasury: game.treasury,
      currentPlayerIndex: game.currentPlayerIndex,
      turnNumber: game.turnNumber,
    };
  }

  /** Move the turn marker to the next player who still has a card. */
  private advance(): void {
    const game = this.game;
    let next = (game.currentPlayerIndex + 1) % game.players.length;
    while (!game.players[next].isAlive) next = (next + 1) % game.players.length;
    game.currentPlayerIndex = next;
    game.turnPhase = TurnPhase.AwaitingAction;
    game.turnNumber++;
  }

  /** After a card was turned up: knock the player out, end the game or move the marker on. */
  private settle(player: Player): void {
    const game = this.game;
    if (player.isAlive) return;
    game.eliminatePlayer(player);

    const alive = game.getAlivePlayers();
    if (alive.length <= 1) {
      if (this.exchangeState) {
        game.deck.returnCards(this.exchangeState.drawnCards);
        this.exchangeState = null;
      }
      const winner = alive[0] ?? null;
      game.status = GameStatus.Finished;
      game.turnPhase = TurnPhase.GameOver;
      game.winnerId = winner?.id ?? null;
      if (winner) {
        game.log({
          message: `${winner.name} wins the game.`,
          msg: logMsg('win', { actor: winner.id }),
          eventType: 'win', actorId: winner.id, actorName: winner.name,
        });
      }
      return;
    }
    if (game.currentPlayer.id === player.id) this.advance();
  }
}
