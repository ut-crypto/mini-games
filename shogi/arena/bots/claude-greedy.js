/*
 * Claude 作: 1手先だけを見る「欲張り」ボット。
 * 詰ませる手 > 得をする駒取り > 成り の順に好み、取られそうなマスへのタダ捨ては避ける。
 */
registerBot({
  name: 'Claude 欲張り',
  author: 'Claude (Anthropic)',
  description: '1手先だけを読み、駒得・成り・詰みを狙う。タダで取られる手は避ける',

  move(state) {
    const VALUE = { P: 1, L: 3, N: 4, S: 5, G: 6, B: 8, R: 10, K: 100 };
    const PROMOTED = { P: 6, L: 6, N: 6, S: 6, B: 11, R: 13 };
    const worth = (pc) => (pc.p ? PROMOTED[pc.t] : VALUE[pc.t]);

    const pos = Shogi.Position.fromSfen(state.sfen);
    const me = pos.side;
    let best = null;
    let bestScore = -Infinity;

    for (const usi of state.legalMoves) {
      const m = pos.findMove(usi);
      const next = pos.apply(m);
      let score = Math.random() * 0.5; // 同点なら少しばらつかせる

      // 相手に指す手がない = 詰み
      if (!next.hasLegalMove()) return usi;

      const captured = m.drop ? null : pos.board[m.to];
      if (captured) score += worth(captured) * 10;
      if (m.promote) score += 3;
      if (next.inCheck(next.side)) score += 1;

      // 動かした先が相手に取られ、こちらの利きがないならタダ捨て
      const moved = next.board[m.to];
      if (next.isAttacked(m.to, 1 - me) && !next.isAttacked(m.to, me)) score -= worth(moved) * 10;
      // 取り合いになるなら、損得を大まかに見る
      else if (next.isAttacked(m.to, 1 - me) && captured) score -= Math.max(0, worth(moved) - worth(captured)) * 5;

      if (score > bestScore) {
        bestScore = score;
        best = usi;
      }
    }
    return best;
  },
});
