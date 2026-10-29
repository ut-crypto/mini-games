/*
 * AI 対戦場: ボットを隔離して動かす Web Worker。
 * ボットのファイルは registerBot({ name, author, move(state) { ... } }) を呼ぶ。
 * Worker なので画面(DOM)やページのデータには触れない。制限時間を超えたら親が terminate する。
 */
importScripts('../shogi-core.js');

(() => {
  'use strict';

  const Core = self.ShogiCore;
  // ボットから使えるヘルパー(ルール判定・局面操作)
  self.Shogi = Core;

  let bot = null;
  self.registerBot = (def) => { bot = def; };
  // AI が書きがちな別の形式も受け付ける: module.exports = {...} / export default {...}
  self.module = { exports: {} };
  self.exports = self.module.exports;

  function normalizeSource(code) {
    return String(code).replace(/^\s*export\s+default\s+/m, 'self.__defaultExport = ');
  }

  function findBot() {
    if (bot) return bot;
    if (self.__defaultExport) return self.__defaultExport;
    if (self.module.exports && typeof self.module.exports.move === 'function') return self.module.exports;
    if (self.bot && typeof self.bot.move === 'function') return self.bot;
    return null;
  }

  const PIECE = (pc) => (pc ? `${pc.p ? '+' : ''}${pc.c === Core.BLACK ? pc.t : pc.t.toLowerCase()}` : null);

  /** ボットに渡す局面情報 */
  function buildState(msg) {
    const game = new Core.Game(msg.startSfen);
    for (const u of msg.history) {
      if (!game.playUsi(u)) throw new Error(`内部エラー: 棋譜を再現できません (${u})`);
    }
    const pos = game.pos;
    const board = [];
    for (let r = 0; r < 9; r++) {
      board.push(pos.board.slice(r * 9, r * 9 + 9).map(PIECE));
    }
    const hand = (c) => ({ ...pos.hands[c] });
    return {
      sfen: pos.toSfen(game.ply + 1),
      side: pos.side === Core.BLACK ? 'black' : 'white',
      ply: game.ply,
      legalMoves: pos.legalMoves().map(Core.moveToUsi),
      history: msg.history.slice(),
      startSfen: msg.startSfen,
      board,
      hands: { black: hand(Core.BLACK), white: hand(Core.WHITE) },
      inCheck: pos.inCheck(),
      timeLimitMs: msg.timeLimitMs,
      deadline: Date.now() + msg.timeLimitMs,
      opponent: msg.opponent,
    };
  }

  self.onmessage = async (e) => {
    const msg = e.data;
    try {
      if (msg.type === 'load') {
        const url = URL.createObjectURL(new Blob([normalizeSource(msg.code)], { type: 'text/javascript' }));
        try {
          importScripts(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const b = findBot();
        if (!b || typeof b.move !== 'function') {
          throw new Error('registerBot({ name, move(state) { ... } }) が呼ばれていません');
        }
        bot = b;
        postMessage({
          type: 'loaded',
          meta: {
            name: String(b.name || '名無しボット').slice(0, 40),
            author: String(b.author || '').slice(0, 60),
            description: String(b.description || '').slice(0, 200),
          },
        });
      } else if (msg.type === 'init') {
        if (typeof bot.init === 'function') await bot.init({ color: msg.color, opponent: msg.opponent, timeLimitMs: msg.timeLimitMs });
        postMessage({ type: 'ready', id: msg.id });
      } else if (msg.type === 'move') {
        const state = buildState(msg);
        let mv = await bot.move(state);
        if (mv && typeof mv === 'object' && 'move' in mv) mv = mv.move;
        postMessage({ type: 'move', id: msg.id, move: typeof mv === 'string' ? mv.trim() : String(mv) });
      }
    } catch (err) {
      postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err).slice(0, 300) });
    }
  };
})();
