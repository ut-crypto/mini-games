/*
 * テンプレート: 合法手からランダムに1手選ぶボット。
 * 新しいボットはこのファイルをコピーして move() を書き換えるだけで作れます。
 * 仕様は shogi/arena/BOT_SPEC.md を参照。
 */
registerBot({
  name: 'ランダム',
  author: 'テンプレート',
  description: '合法手からランダムに選ぶだけのボット(仕様の見本)',

  // 1手ごとに呼ばれる。state.legalMoves から USI 形式の指し手を1つ返す
  move(state) {
    const moves = state.legalMoves;
    return moves[Math.floor(Math.random() * moves.length)];
  },
});
