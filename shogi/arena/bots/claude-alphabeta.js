/*
 * Claude 作: 反復深化 αβ 探索のボット。
 *   - 評価: 駒の価値(持ち駒は少し高め)+ 玉の周りの守り駒・攻め駒
 *   - 探索: 反復深化 αβ + 駒取りだけを読む静止探索。持ち時間の約7割で打ち切る
 *   - 枝刈り: 内部ノードでは、玉の近く(2マス以内)以外への駒打ちと、成れるのに成らない飛角歩は読まない
 */
registerBot({
  name: 'Claude αβ',
  author: 'Claude (Anthropic)',
  description: '反復深化αβ探索+静止探索。駒得と玉の守りを評価する',

  move(state) {
    const S = Shogi;
    const BLACK = S.BLACK;
    const BOARD_VALUE = { P: 90, L: 315, N: 405, S: 495, G: 540, B: 855, R: 990, K: 0 };
    const PROMOTED_VALUE = { P: 540, L: 540, N: 540, S: 540, B: 945, R: 1395 };
    const HAND_VALUE = { P: 105, L: 350, N: 450, S: 560, G: 610, B: 960, R: 1120 };
    const MATE = 100000;
    const deadline = Date.now() + state.timeLimitMs * 0.7;
    const TIMEOUT = {};
    let nodes = 0;

    const rowOf = (i) => Math.floor(i / 9);
    const colOf = (i) => i % 9;
    const dist = (a, b) => Math.max(Math.abs(rowOf(a) - rowOf(b)), Math.abs(colOf(a) - colOf(b)));
    const pieceValue = (pc) => (pc.p ? PROMOTED_VALUE[pc.t] : BOARD_VALUE[pc.t]);

    /** 手番側から見た評価値 */
    function evaluate(pos) {
      let score = 0;
      const kings = [pos.kingSq(0), pos.kingSq(1)];
      for (let i = 0; i < 81; i++) {
        const pc = pos.board[i];
        if (!pc) continue;
        const sign = pc.c === BLACK ? 1 : -1;
        score += sign * pieceValue(pc);
        if (pc.t === 'K') continue;
        // 自玉の近くの金銀は守り、相手玉の近くの駒は攻め
        if (kings[pc.c] >= 0 && dist(i, kings[pc.c]) <= 1 && (pc.t === 'G' || pc.t === 'S' || pc.p)) score += sign * 35;
        const enemyKing = kings[1 - pc.c];
        if (enemyKing >= 0 && dist(i, enemyKing) <= 2) score += sign * 25;
      }
      for (const t in HAND_VALUE) {
        score += (pos.hands[0][t] - pos.hands[1][t]) * HAND_VALUE[t];
      }
      return pos.side === BLACK ? score : -score;
    }

    function moveOrderScore(pos, m) {
      let s = 0;
      if (!m.drop) {
        const cap = pos.board[m.to];
        if (cap) s += 10 * pieceValue(cap) - pieceValue(pos.board[m.from]) / 10;
      }
      if (m.promote) s += 400;
      return s;
    }

    /** 内部ノードの候補手(枝刈りあり) */
    function candidates(pos) {
      const kings = [pos.kingSq(0), pos.kingSq(1)];
      const out = [];
      for (const m of pos.pseudoMoves()) {
        if (m.drop) {
          if (dist(m.to, kings[0]) > 2 && dist(m.to, kings[1]) > 2) continue;
        } else if (!m.promote) {
          const pc = pos.board[m.from];
          if (!pc.p && (pc.t === 'P' || pc.t === 'B' || pc.t === 'R')) {
            // 成れるのに成らない手は読まない
            const canPromote = S.inZone(pc.c, rowOf(m.from)) || S.inZone(pc.c, rowOf(m.to));
            if (canPromote) continue;
          }
        }
        out.push(m);
      }
      return out.sort((a, b) => moveOrderScore(pos, b) - moveOrderScore(pos, a));
    }

    function tick() {
      if ((++nodes & 255) === 0 && Date.now() > deadline) throw TIMEOUT;
    }

    function quiesce(pos, alpha, beta, qd) {
      tick();
      const stand = evaluate(pos);
      if (stand >= beta || qd >= 4) return stand;
      if (stand > alpha) alpha = stand;
      const me = pos.side;
      const caps = pos.pseudoMoves()
        .filter((m) => !m.drop && pos.board[m.to])
        .sort((a, b) => moveOrderScore(pos, b) - moveOrderScore(pos, a));
      for (const m of caps) {
        if (pos.board[m.to].t === 'K') return MATE; // 玉を取れる = 直前の手が反則
        const next = pos.apply(m);
        if (next.inCheck(me)) continue;
        const sc = -quiesce(next, -beta, -alpha, qd + 1);
        if (sc >= beta) return sc;
        if (sc > alpha) alpha = sc;
      }
      return alpha;
    }

    function search(pos, depth, alpha, beta, ply) {
      tick();
      if (depth <= 0) return quiesce(pos, alpha, beta, 0);
      const me = pos.side;
      let any = false;
      for (const m of candidates(pos)) {
        const next = pos.apply(m);
        if (next.inCheck(me)) continue;
        any = true;
        const sc = -search(next, depth - 1, -beta, -alpha, ply + 1);
        if (sc >= beta) return sc;
        if (sc > alpha) alpha = sc;
      }
      if (!any) {
        // 枝刈りで候補がなくなっただけかもしれないので、本当に指す手がないかを確認
        return pos.hasLegalMove() ? evaluate(pos) : -MATE + ply;
      }
      return alpha;
    }

    const root = S.Position.fromSfen(state.sfen);
    let rootMoves = root.legalMoves().sort((a, b) => moveOrderScore(root, b) - moveOrderScore(root, a));
    let best = rootMoves[0];

    try {
      for (let depth = 1; depth <= 12; depth++) {
        let alpha = -Infinity;
        let bestAtDepth = null;
        const scored = [];
        for (const m of rootMoves) {
          const sc = -search(root.apply(m), depth - 1, -Infinity, -alpha, 1);
          scored.push([sc, m]);
          if (sc > alpha) {
            alpha = sc;
            bestAtDepth = m;
          }
        }
        best = bestAtDepth || best;
        // 次の深さは良かった手から読む
        rootMoves = scored.sort((a, b) => b[0] - a[0]).map((x) => x[1]);
        if (alpha >= MATE - 100) break; // 詰みを見つけた
      }
    } catch (e) {
      if (e !== TIMEOUT) throw e;
    }
    return S.moveToUsi(best);
  },
});
