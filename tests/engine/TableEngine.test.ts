import { describe, it, expect } from 'vitest';
import { TableEngine } from '@/engine/TableEngine';
import { ActionType, Character, GameMode, GameState, GameStatus, TurnPhase } from '@/shared/types';
import { logLinePlain } from '@/app/i18n/logText';
import { makePlainTranslator } from '@/app/i18n/runtime';

const NAMES = ['Alice', 'Bob', 'Charlie', 'Diana'];

function createEngine(playerCount = 3, firstPlayerId?: string): TableEngine {
  const engine = new TableEngine('TABL');
  const players = Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, name: NAMES[i] }));
  engine.startGame(players, { firstPlayerId });
  return engine;
}

function setCards(engine: TableEngine, playerId: string, cards: Character[]): void {
  engine.game.getPlayer(playerId)!.influences = cards.map(character => ({ character, revealed: false }));
}

const coins = (engine: TableEngine, id: string) => engine.game.getPlayer(id)!.coins;
const lastLog = (engine: TableEngine) => engine.game.actionLog[engine.game.actionLog.length - 1];

describe('TableEngine', () => {
  describe('starting', () => {
    it('deals Classic hands, in seat order, with the chosen player first', () => {
      const engine = createEngine(4, 'p3');
      const state = engine.getFullState();
      expect(state.tableMode).toBe(true);
      expect(state.gameMode).toBe(GameMode.Classic);
      expect(state.players.map(p => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(state.players.every(p => p.influences.length === 2 && p.coins === 2)).toBe(true);
      expect(state.players[state.currentPlayerIndex].id).toBe('p3');
      expect(state.deck).toHaveLength(15 - 8);
      expect(state.timerExpiry).toBeNull();
      expect(state.deck).not.toContain(Character.Inquisitor);
    });

    it('starts with the first seat when no first player was chosen', () => {
      expect(createEngine(3).game.currentPlayer.id).toBe('p1');
      expect(createEngine(3, 'nobody').game.currentPlayer.id).toBe('p1');
    });

    it('never runs the online game: its entry points do nothing', () => {
      const engine = createEngine();
      expect(engine.handleAction()).toBe('Invalid action');
      expect(engine.handleChallenge()).toBe('Invalid action');
      engine.handleTimerExpiry();
      expect(engine.game.currentPlayer.id).toBe('p1');
      expect(coins(engine, 'p1')).toBe(2);
    });
  });

  describe('turn entries', () => {
    it('Income, Foreign Aid and Tax add coins and pass the turn on', () => {
      const engine = createEngine();
      expect(engine.tableAction('p1', ActionType.Income)).toBeNull();
      expect(coins(engine, 'p1')).toBe(3);
      expect(engine.game.currentPlayer.id).toBe('p2');
      expect(engine.tableAction('p2', ActionType.ForeignAid)).toBeNull();
      expect(coins(engine, 'p2')).toBe(4);
      expect(engine.tableAction('p3', ActionType.Tax)).toBeNull();
      expect(coins(engine, 'p3')).toBe(5);
      expect(engine.game.currentPlayer.id).toBe('p1');
      expect(engine.game.treasury).toBe(50 - 6 - 1 - 2 - 3);
    });

    it('only the player whose turn it is can record', () => {
      const engine = createEngine();
      expect(engine.tableAction('p2', ActionType.Tax)).toBe('Not your turn');
      expect(coins(engine, 'p2')).toBe(2);
    });

    it('Steal moves up to 2 coins from the target', () => {
      const engine = createEngine();
      engine.game.getPlayer('p2')!.coins = 1;
      expect(engine.tableAction('p1', ActionType.Steal)).toBe('This action requires a target');
      expect(engine.tableAction('p1', ActionType.Steal, 'p1')).toBe('Cannot target yourself');
      expect(engine.tableAction('p1', ActionType.Steal, 'p2')).toBeNull();
      expect(coins(engine, 'p1')).toBe(3);
      expect(coins(engine, 'p2')).toBe(0);
      expect(engine.tableAction('p2', ActionType.Steal, 'p3')).toBeNull();
      expect(coins(engine, 'p2')).toBe(2);
      expect(coins(engine, 'p3')).toBe(0);
      expect(engine.tableAction('p3', ActionType.Steal, 'p3')).toBe('Cannot target yourself');
      engine.game.getPlayer('p1')!.coins = 0;
      expect(engine.tableAction('p3', ActionType.Steal, 'p1')).toBe('Target has no coins to steal');
    });

    it('Assassinate and Coup only take the payment: the target turns their own card', () => {
      const engine = createEngine();
      expect(engine.tableAction('p1', ActionType.Assassinate)).toBe('Not enough coins (need 3, have 2)');
      engine.game.getPlayer('p1')!.coins = 8;
      expect(engine.tableAction('p1', ActionType.Assassinate)).toBeNull();
      expect(coins(engine, 'p1')).toBe(5);
      expect(engine.game.players.every(p => p.aliveInfluenceCount === 2)).toBe(true);
      engine.game.getPlayer('p2')!.coins = 7;
      expect(engine.tableAction('p2', ActionType.Coup)).toBeNull();
      expect(coins(engine, 'p2')).toBe(0);
      expect(engine.game.currentPlayer.id).toBe('p3');
    });

    it('a pass ends the turn with nothing changed; the host can pass for someone else', () => {
      const engine = createEngine();
      expect(engine.tablePass('p2', false)).toBe('Not your turn');
      expect(engine.tablePass('p1', false)).toBeNull();
      expect(engine.game.currentPlayer.id).toBe('p2');
      expect(engine.tablePass('p1', true)).toBeNull();
      expect(engine.game.currentPlayer.id).toBe('p3');
      expect(engine.game.players.every(p => p.coins === 2)).toBe(true);
    });

    it('rejects actions outside the Classic table set', () => {
      const engine = createEngine();
      expect(engine.tableAction('p1', ActionType.Embezzle as never)).toBe('Invalid action');
    });
  });

  describe('exchange', () => {
    it('draws 2, keeps the chosen cards and returns the rest to the deck', () => {
      const engine = createEngine();
      setCards(engine, 'p1', [Character.Duke, Character.Captain]);
      engine.game.deck.setCards([Character.Contessa, Character.Assassin, Character.Ambassador]);
      expect(engine.tableAction('p1', ActionType.Exchange)).toBeNull();
      const state = engine.getFullState();
      expect(state.turnPhase).toBe(TurnPhase.AwaitingExchange);
      expect(state.exchangeState).toEqual({ playerId: 'p1', drawnCards: [Character.Ambassador, Character.Assassin] });
      expect(engine.game.currentPlayer.id).toBe('p1');

      // available = [Duke, Captain, Ambassador, Assassin]
      expect(engine.tableExchange('p2', [0, 1])).toBe('Not your exchange');
      expect(engine.tableExchange('p1', [0])).toBe('Must keep exactly 2 cards');
      expect(engine.tableExchange('p1', [0, 0])).toBe('Duplicate card indices');
      expect(engine.tableExchange('p1', [0, 9])).toBe('Invalid card index');
      expect(engine.tableExchange('p1', [3, 0])).toBeNull();

      expect(engine.game.getPlayer('p1')!.hiddenCharacters).toEqual([Character.Assassin, Character.Duke]);
      expect([...engine.game.deck.getCards()].sort()).toEqual([Character.Ambassador, Character.Captain, Character.Contessa].sort());
      expect(engine.getFullState().exchangeState).toBeNull();
      expect(engine.game.currentPlayer.id).toBe('p2');
    });

    it('holds the exchanging player to finishing it, and lets the host abandon it', () => {
      const engine = createEngine();
      const deckBefore = engine.game.deck.size;
      engine.tableAction('p1', ActionType.Exchange);
      expect(engine.tableLoseInfluence('p1', 0)).toBe('Finish your exchange first');
      expect(engine.tablePass('p1', false)).toBe('Finish your exchange first');
      expect(engine.tableAction('p2', ActionType.Income)).toBe('Not your turn');
      // Someone else can still lose a card meanwhile.
      expect(engine.tableLoseInfluence('p2', 0)).toBeNull();
      // p1's phone is away: the host moves the game on.
      expect(engine.tablePass('p3', true)).toBeNull();
      expect(engine.getFullState().exchangeState).toBeNull();
      expect(engine.game.deck.size).toBe(deckBefore);
      expect(engine.game.currentPlayer.id).toBe('p2');
    });

    it('a player with one card keeps one', () => {
      const engine = createEngine();
      engine.tableLoseInfluence('p1', 0);
      engine.tableAction('p1', ActionType.Exchange);
      expect(engine.tableExchange('p1', [0, 1])).toBe('Must keep exactly 1 card');
      expect(engine.tableExchange('p1', [2])).toBeNull();
      expect(engine.game.getPlayer('p1')!.aliveInfluenceCount).toBe(1);
    });
  });

  describe('cards, at any time', () => {
    it('losing a card turns it up, whoever\'s turn it is', () => {
      const engine = createEngine();
      setCards(engine, 'p3', [Character.Duke, Character.Contessa]);
      expect(engine.tableLoseInfluence('p3', 1)).toBeNull();
      expect(engine.game.getPlayer('p3')!.influences).toEqual([
        { character: Character.Duke, revealed: false },
        { character: Character.Contessa, revealed: true },
      ]);
      expect(engine.tableLoseInfluence('p3', 1)).toBe('That influence is already revealed');
      expect(engine.tableLoseInfluence('p3', 5)).toBe('Invalid influence index');
      expect(engine.game.currentPlayer.id).toBe('p1');
    });

    it('showing a card puts it back in the deck and draws a replacement', () => {
      const engine = createEngine();
      setCards(engine, 'p2', [Character.Duke, Character.Contessa]);
      engine.game.deck.setCards([Character.Assassin]);
      expect(engine.tableProveInfluence('p2', 0)).toBeNull();
      const p2 = engine.game.getPlayer('p2')!;
      expect(p2.aliveInfluenceCount).toBe(2);
      expect(p2.influences[1].character).toBe(Character.Contessa);
      // Duke went back and one of {Duke, Assassin} came out.
      expect([p2.influences[0].character, ...engine.game.deck.getCards()].sort()).toEqual([Character.Assassin, Character.Duke].sort());
      expect(lastLog(engine).character).toBe(Character.Duke);
    });

    it('a player with no cards left is out, gives up their coins and is skipped', () => {
      const engine = createEngine();
      engine.game.getPlayer('p2')!.coins = 5;
      const treasury = engine.game.treasury;
      engine.tableLoseInfluence('p2', 0);
      engine.tableLoseInfluence('p2', 1);
      expect(engine.game.getPlayer('p2')!.isAlive).toBe(false);
      expect(coins(engine, 'p2')).toBe(0);
      expect(engine.game.treasury).toBe(treasury + 5);
      expect(engine.tableLoseInfluence('p2', 0)).toBe('You are eliminated');
      engine.tableAction('p1', ActionType.Income);
      expect(engine.game.currentPlayer.id).toBe('p3');
    });

    it('the turn moves on when the current player is knocked out', () => {
      const engine = createEngine();
      engine.tableLoseInfluence('p1', 0);
      engine.tableLoseInfluence('p1', 1);
      expect(engine.game.currentPlayer.id).toBe('p2');
    });

    it('the last player with a card wins', () => {
      const engine = createEngine(2);
      const states: GameState[] = [];
      engine.setOnStateChange(s => states.push(s));
      engine.tableLoseInfluence('p2', 0);
      engine.tableLoseInfluence('p2', 1);
      const final = states[states.length - 1];
      expect(final.status).toBe(GameStatus.Finished);
      expect(final.turnPhase).toBe(TurnPhase.GameOver);
      expect(final.winnerId).toBe('p1');
      expect(lastLog(engine).eventType).toBe('win');
      expect(engine.tableAction('p1', ActionType.Income)).toBe('No game in progress');
    });
  });

  describe('corrections', () => {
    it('undo takes back your own last coin entry and gives the turn back', () => {
      const engine = createEngine();
      engine.tableAction('p1', ActionType.Steal, 'p2');
      expect(engine.getFullState().tableUndoPlayerId).toBe('p1');
      expect(engine.tableUndo('p2')).toBe('Nothing to take back');
      expect(engine.tableUndo('p1')).toBeNull();
      expect(coins(engine, 'p1')).toBe(2);
      expect(coins(engine, 'p2')).toBe(2);
      expect(engine.game.currentPlayer.id).toBe('p1');
      expect(engine.getFullState().tableUndoPlayerId).toBeNull();
      expect(engine.tableUndo('p1')).toBe('Nothing to take back');
    });

    it('nothing can be undone once a card has been seen or turned', () => {
      const engine = createEngine();
      engine.tableAction('p1', ActionType.Tax);
      engine.tableLoseInfluence('p3', 0);
      expect(engine.tableUndo('p1')).toBe('Nothing to take back');
      expect(coins(engine, 'p1')).toBe(5);
    });

    it('a coin correction changes your own coins by one and keeps the turn', () => {
      const engine = createEngine();
      expect(engine.tableAdjustCoins('p3', 1)).toBeNull();
      expect(engine.tableAdjustCoins('p3', -1)).toBeNull();
      expect(engine.tableAdjustCoins('p3', -1)).toBeNull();
      expect(coins(engine, 'p3')).toBe(1);
      expect(engine.tableAdjustCoins('p3', 5)).toBe('Invalid action');
      engine.tableAdjustCoins('p3', -1);
      expect(engine.tableAdjustCoins('p3', -1)).toBe('Not enough coins (need 1, have 0)');
      expect(engine.game.currentPlayer.id).toBe('p1');
    });

    it('a player who walks away is out, and an open exchange goes back to the deck', () => {
      const engine = createEngine();
      const deckBefore = engine.game.deck.size;
      engine.tableAction('p1', ActionType.Exchange);
      expect(engine.tableForfeit('p1')).toBe(true);
      expect(engine.game.getPlayer('p1')!.isAlive).toBe(false);
      expect(engine.game.deck.size).toBe(deckBefore);
      expect(engine.getFullState().exchangeState).toBeNull();
      expect(engine.game.currentPlayer.id).toBe('p2');
      expect(engine.tableForfeit('p1')).toBe(false);
    });
  });

  it('every log line renders from its key to exactly the English text', () => {
    const t = makePlainTranslator('en');
    const engine = createEngine(4);
    const names = new Map(engine.game.players.map(p => [p.id, p.name]));
    engine.game.getPlayer('p1')!.coins = 10;
    engine.tableAction('p1', ActionType.Coup);
    engine.tableAction('p2', ActionType.Income);
    engine.tableAction('p3', ActionType.ForeignAid);
    engine.tableAction('p4', ActionType.Tax);
    engine.tableAction('p1', ActionType.Assassinate);
    engine.tableAction('p2', ActionType.Steal, 'p4');
    engine.tableUndo('p2');
    engine.tablePass('p2', false);
    engine.tableProveInfluence('p3', 0);
    engine.tableAdjustCoins('p3', 1);
    engine.tableAdjustCoins('p3', -1);
    engine.tableAction('p3', ActionType.Exchange);
    engine.tableExchange('p3', [0, 1]);
    engine.game.deck.setCards([]);
    engine.tableAction('p4', ActionType.Exchange);
    engine.tableForfeit('p4');
    engine.tableLoseInfluence('p2', 0);
    engine.tableLoseInfluence('p2', 1);
    engine.tableLoseInfluence('p3', 0);
    engine.tableLoseInfluence('p3', 1);
    expect(engine.game.status).toBe(GameStatus.Finished);

    const keys = new Set<string>();
    for (const entry of engine.game.actionLog) {
      expect(entry.msg, entry.message).toBeDefined();
      keys.add(entry.msg!.key);
      expect(logLinePlain(entry, t, names)).toBe(entry.message);
    }
    for (const key of ['tableCoupPaid', 'tableAssassinatePaid', 'tableProved', 'tablePassed', 'tableUndone', 'tableCoinsAdded', 'tableCoinsRemoved', 'tableLeft', 'exchangeDeckEmpty', 'win']) {
      expect(keys, key).toContain(key);
    }
  });
});
