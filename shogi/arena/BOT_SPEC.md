# 将棋ボット仕様書(AI 対戦場 v1)

あなたには、ブラウザ上の「将棋 AI 対戦場」で他のボットと対局する将棋ボットを、
JavaScript ファイル1つで書いてもらいます。以下の仕様に厳密に従ってください。

## ファイルの形

- JavaScript ファイル1つ(拡張子 `.js`)。ブラウザの Web Worker 内で実行されます。
- `import` / `require` / 外部ファイルの読み込みは使えません(1ファイルで完結させること)。
- DOM(`document` / `window`)は使えません。
- ファイルの中で `registerBot({...})` を **1回だけ** 呼んでください。

```js
registerBot({
  name: 'ボットの名前',          // 必須(40文字まで)
  author: '作者(例: ChatGPT)',   // 任意。どの AI が作ったかを書く
  description: '戦略の説明',      // 任意(200文字まで)

  // 任意: 対局の開始時に1回呼ばれる
  init(info) {
    // info = { color: 'black' | 'white', opponent: '相手の名前', timeLimitMs: 1手の持ち時間(ミリ秒) }
  },

  // 必須: 自分の手番のたびに呼ばれる。指し手を USI 形式の文字列で返す(Promise を返してもよい)
  move(state) {
    return state.legalMoves[0];
  },
});
```

## move(state) に渡される state

| プロパティ | 内容 |
|---|---|
| `legalMoves` | 今の局面の **合法手の一覧**(USI 形式の文字列の配列)。必ずこの中から返すこと |
| `sfen` | 今の局面(SFEN 形式。例: `lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1`) |
| `side` | 自分の手番: `'black'`(先手▲)または `'white'`(後手△) |
| `ply` | これまでの手数(0 から) |
| `history` | 開始局面からの指し手(USI 形式の配列) |
| `board` | 盤面。`board[段][筋]` の 9×9 配列。段は 0=一段目(上・後手側)〜8=九段目、筋は 0=9筋(左)〜8=1筋(右)。値は駒の文字列か `null` |
| `hands` | 持ち駒。`{ black: { R, B, G, S, N, L, P }, white: {...} }`(各枚数) |
| `inCheck` | 自分が王手をかけられているか |
| `timeLimitMs` | 1手の持ち時間(ミリ秒) |
| `deadline` | この時刻(`Date.now()` の値)までに返すこと |
| `opponent` | 相手の名前 |

駒の文字: 先手は大文字、後手は小文字。`P`歩 `L`香 `N`桂 `S`銀 `G`金 `B`角 `R`飛 `K`玉。成り駒は先頭に `+`(例: `+P` と金、`+r` 後手の龍)。

## 指し手の形式(USI)

- 盤上の駒を動かす: `7g7f`(7筋g段 → 7筋f段)。成るときは末尾に `+`(例: `8h2b+`)
- 持ち駒を打つ: `P*5e`(歩を5筋e段に打つ)
- 筋は 1〜9(右から左)、段は a〜i(上から下。a=一段目)
- 投了するときは `'resign'` を返してもよい

## ルール(対戦場が判定します)

- 先手・後手は1局ごとに入れ替わります。
- 次の場合は **負け** になります。
  - 持ち時間(`timeLimitMs`)+0.5秒以内に返さなかった(処理が止まらないボットは強制終了されます)
  - 合法手でない文字列を返した
  - `move()` の中で例外が起きた
- 詰み・千日手(4回同一局面で引き分け、連続王手の側は負け)・512手到達(引き分け)は通常の将棋と同じです。
- 二歩・打ち歩詰め・行き所のない駒は `legalMoves` に最初から含まれません。

## 使えるヘルパー: `Shogi`(任意)

探索を書きたいときは、グローバルの `Shogi` でルール判定を使えます(自分で実装してもかまいません)。

```js
const pos = Shogi.Position.fromSfen(state.sfen); // 局面
pos.side;                         // 手番 0=先手 1=後手
pos.board[i];                     // i = 段*9 + 筋(0=9筋)。{ c: 手番, t: 'P'など, p: 成り } または null
pos.hands[0].P;                   // 先手の持ち歩の枚数
const moves = pos.legalMoves();   // 合法手(オブジェクト)
Shogi.moveToUsi(moves[0]);        // → 'USI 文字列'
const m = pos.findMove('7g7f');   // USI 文字列 → 手(非合法なら null)
const next = pos.apply(m);        // 手を指した後の新しい局面(元の局面は変わらない)
next.inCheck();                   // 手番側が王手されているか
next.hasLegalMove();              // 手番側に指せる手があるか(false なら詰み)
pos.isAttacked(i, color);         // マス i に color 側の駒が利いているか
pos.pseudoMoves();                // 王手放置などを確認しない高速な手の一覧
```

`legalMoves()` は打ち歩詰めの確認まで行うので遅めです。探索の内部では
`pseudoMoves()` で手を作り、`apply()` 後に `next.inCheck(自分の手番)` が true の手を除くと速くなります。

## 書くときの注意

- 持ち時間を超えないよう、`state.deadline` を見て余裕を持って(7割程度で)探索を打ち切ってください。
- 返す手は必ず `state.legalMoves` に含まれる文字列にしてください。
- グローバル変数で状態を持ってもかまいません(同じ対局の間は同じ Worker で動きます)。

## 例: 駒を取れるなら一番高い駒を取り、なければランダム

```js
registerBot({
  name: '駒取り屋',
  author: 'サンプル',
  move(state) {
    const VALUE = { p: 1, l: 3, n: 4, s: 5, g: 6, b: 8, r: 10 };
    const pos = Shogi.Position.fromSfen(state.sfen);
    let best = null;
    let bestValue = 0;
    for (const usi of state.legalMoves) {
      const m = pos.findMove(usi);
      const target = m.drop ? null : pos.board[m.to];
      const v = target ? VALUE[target.t.toLowerCase()] || 0 : 0;
      if (v > bestValue) { bestValue = v; best = usi; }
    }
    return best || state.legalMoves[Math.floor(Math.random() * state.legalMoves.length)];
  },
});
```
