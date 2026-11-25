import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomManager } from '@/server/RoomManager';
import { TableEngine } from '@/engine/TableEngine';
import { GameEngine } from '@/engine/GameEngine';
import { DEFAULT_ROOM_SETTINGS, DISCONNECT_BOT_REPLACE_MS, INACTIVE_ROOM_CLEANUP_MS, LOBBY_DISCONNECT_GRACE_MS } from '@/shared/constants';
import { GameMode, GameStatus } from '@/shared/types';

/** Table mode: playing in person. Seats and first player are the host's; nobody loses a seat to a sleeping phone. */
describe('RoomManager table mode', () => {
  let manager: RoomManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new RoomManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  function tableRoom(names = ['Alice', 'Bob', 'Cara']) {
    const { room, playerId } = manager.createRoom(names[0], 's0');
    const ids = [playerId];
    names.slice(1).forEach((name, i) => {
      const joined = manager.joinRoom(room.code, name, `s${i + 1}`);
      if ('error' in joined) throw new Error(joined.error);
      ids.push(joined.playerId);
    });
    expect(manager.updateSettings(room.code, { ...DEFAULT_ROOM_SETTINGS, tableMode: true })).toEqual({ success: true });
    return { room, ids };
  }

  describe('settings', () => {
    it('turns on with Classic rules, and off again without leaving a trace', () => {
      const { room } = manager.createRoom('Alice', 's0');
      manager.updateSettings(room.code, { ...DEFAULT_ROOM_SETTINGS, tableMode: true, gameMode: GameMode.Reformation, useInquisitor: true });
      expect(room.settings.tableMode).toBe(true);
      expect(room.settings.gameMode).toBe(GameMode.Classic);
      expect(room.settings.useInquisitor).toBe(false);
      manager.updateSettings(room.code, { ...DEFAULT_ROOM_SETTINGS, tableMode: false });
      expect(room.settings).toEqual(DEFAULT_ROOM_SETTINGS);
    });

    it('is for people only', () => {
      const { room } = manager.createRoom('Alice', 's0');
      manager.addBot(room.code, 'HAL', 'optimal');
      expect(manager.updateSettings(room.code, { ...DEFAULT_ROOM_SETTINGS, tableMode: true }))
        .toEqual({ error: 'Table mode is for people only. Remove the bots first.' });

      const table = tableRoom();
      expect(manager.addBot(table.room.code, 'HAL', 'optimal'))
        .toEqual({ error: 'Table mode is for people only. Remove the bots first.' });
    });
  });

  describe('seats and first player', () => {
    it('the host sets the seat order, and the game deals in it', () => {
      const { room, ids } = tableRoom();
      const order = [ids[2], ids[0], ids[1]];
      expect(manager.setSeatOrder(room.code, order)).toEqual({ success: true });
      expect(room.players.map(p => p.id)).toEqual(order);

      const engine = manager.startGame(room.code) as GameEngine;
      expect(engine).toBeInstanceOf(TableEngine);
      expect(engine.game.players.map(p => p.id)).toEqual(order);
      // No first player chosen: the first seat starts.
      expect(engine.game.currentPlayer.id).toBe(ids[2]);
    });

    it('rejects an order that is not exactly the players in the room', () => {
      const { room, ids } = tableRoom();
      expect(manager.setSeatOrder(room.code, [ids[0], ids[1]])).toEqual({ error: 'Invalid seat order' });
      expect(manager.setSeatOrder(room.code, [ids[0], ids[1], ids[1]])).toEqual({ error: 'Invalid seat order' });
      expect(manager.setSeatOrder(room.code, [ids[0], ids[1], 'stranger'])).toEqual({ error: 'Invalid seat order' });
      expect(room.players.map(p => p.id)).toEqual(ids);
    });

    it('the chosen first player takes the first turn, and the choice survives a rematch', () => {
      const { room, ids } = tableRoom();
      expect(manager.setFirstPlayer(room.code, 'stranger')).toEqual({ error: 'Invalid first player' });
      expect(manager.setFirstPlayer(room.code, ids[1])).toEqual({ success: true });

      let engine = manager.startGame(room.code) as TableEngine;
      expect(engine.game.currentPlayer.id).toBe(ids[1]);
      expect(manager.setSeatOrder(room.code, ids)).toEqual({ error: 'Cannot change the seats during a game' });
      expect(manager.setFirstPlayer(room.code, ids[0])).toEqual({ error: 'Cannot change the seats during a game' });

      for (const id of [ids[0], ids[2]]) { engine.tableLoseInfluence(id, 0); engine.tableLoseInfluence(id, 1); }
      expect(engine.game.status).toBe(GameStatus.Finished);
      manager.resetToLobby(room.code);
      expect(room.players.map(p => p.id)).toEqual(ids);

      engine = manager.startGame(room.code) as TableEngine;
      expect(engine.game.currentPlayer.id).toBe(ids[1]);
    });

    it('the online game still picks its own first player and engine', () => {
      const { room } = manager.createRoom('Alice', 's0');
      manager.joinRoom(room.code, 'Bob', 's1');
      const engine = manager.startGame(room.code) as GameEngine;
      expect(engine).not.toBeInstanceOf(TableEngine);
      expect(engine.getFullState().tableMode).toBeUndefined();
    });
  });

  describe('a sleeping phone keeps its seat', () => {
    it('in the lobby', () => {
      const { room, ids } = tableRoom();
      manager.disconnectPlayer(room.code, ids[1]);
      expect(manager.hasDisconnectTimer(room.code, ids[1])).toBe(false);
      vi.advanceTimersByTime(LOBBY_DISCONNECT_GRACE_MS * 10);
      expect(room.players.map(p => p.id)).toEqual(ids);
    });

    it('a seat already in its grace period is kept when table mode is turned on', () => {
      const { room, playerId } = manager.createRoom('Alice', 's0');
      const bob = manager.joinRoom(room.code, 'Bob', 's1');
      if ('error' in bob) throw new Error(bob.error);
      manager.disconnectPlayer(room.code, bob.playerId);
      expect(manager.hasDisconnectTimer(room.code, bob.playerId)).toBe(true);
      manager.updateSettings(room.code, { ...DEFAULT_ROOM_SETTINGS, tableMode: true });
      vi.advanceTimersByTime(LOBBY_DISCONNECT_GRACE_MS * 2);
      expect(room.players.map(p => p.id)).toEqual([playerId, bob.playerId]);
      // Turned off again: the online game's grace applies.
      manager.updateSettings(room.code, { ...DEFAULT_ROOM_SETTINGS, tableMode: false });
      vi.advanceTimersByTime(LOBBY_DISCONNECT_GRACE_MS + 1);
      expect(room.players.map(p => p.id)).toEqual([playerId]);
    });

    it('during a game: no bot takes it and the room is not swept', () => {
      const { room, ids } = tableRoom();
      manager.startGame(room.code);
      for (const id of ids) manager.disconnectPlayer(room.code, id);
      expect(manager.replaceWithBot(room.code, ids[0], 'disconnect')).toBe(false);
      vi.advanceTimersByTime(Math.max(DISCONNECT_BOT_REPLACE_MS, INACTIVE_ROOM_CLEANUP_MS) * 3 + 60_000);
      expect(manager.getRoom(room.code)).toBeDefined();
      expect(room.players.every(p => !p.isBot)).toBe(true);

      const back = manager.rejoinRoom(room.code, ids[0], 'new-socket', room.players[0].sessionToken);
      expect('error' in back).toBe(false);
    });

    it('through a rematch, unless the player walked away', () => {
      const { room, ids } = tableRoom();
      const engine = manager.startGame(room.code) as TableEngine;
      manager.disconnectPlayer(room.code, ids[1]);   // phone asleep
      manager.leaveRoom(room.code, ids[2]);          // left for good
      engine.tableForfeit(ids[2]);
      engine.tableLoseInfluence(ids[1], 0);
      engine.tableLoseInfluence(ids[1], 1);
      expect(engine.game.status).toBe(GameStatus.Finished);
      manager.onGameFinished(room.code);
      vi.advanceTimersByTime(LOBBY_DISCONNECT_GRACE_MS * 2);
      manager.resetToLobby(room.code);
      expect(room.players.map(p => p.id)).toEqual([ids[0], ids[1]]);
    });
  });
});
