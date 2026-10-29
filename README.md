# Mini Games

ブラウザで遊べるミニゲーム集。GitHub Pages で公開:<https://ut-crypto.github.io/mini-games/>

| ゲーム | 内容 | URL |
|---|---|---|
| Hit & Blow 5 | 重複なし5桁の数字を当てる推理ゲーム(ひとりで練習 / オンライン対戦) | `/hit-and-blow/` |
| 将棋 | CPU 対戦(5段階)/ オンライン対戦 / ふたりで対局、形勢バー付き | `/shogi/` |
| 将棋 AI 対戦場 | 色々な AI が作った将棋ボットを持ち込んで総当たり戦 | `/shogi/arena/` |

## 構成

```
index.html          ゲーム一覧(トップページ)
shared/theme.css    共通デザイン(配色・フォント・パネル・ボタンなど)
shared/online.js    ルームキーで2人をつなぐオンライン接続(PeerJS)
hit-and-blow/       Hit & Blow 5
shogi/              将棋
  shogi-core.js     ルール(合法手・王手・詰み・千日手・棋譜表記)
  engine.js         CPU(やねうら王 WebAssembly 版を USI で操作)
  engine/           やねうら王のビルド(GPLv3)
  coi-sw.js         SharedArrayBuffer を有効にする Service Worker
shared/vendor/      PeerJS 1.5.4(MIT)
```

## ゲームの追加方法

1. `新しいゲーム名/index.html` を作り、`<head>` で `../shared/theme.css` を読み込む
2. 一覧へ戻るリンク `<a class="back-link" href="../">← GAMES</a>` を置く
3. オンライン対戦が必要なら PeerJS と `../shared/online.js` を読み込み、`OnlineRoom.create('ゲーム固有のプレフィックス-', {...})` を使う(使い方は `shared/online.js` 冒頭のコメント参照)。プレフィックスはゲームごとに変えること
4. トップの `index.html` の一覧にカードを追加する

## 公開方法(GitHub Pages)

**Settings → Pages** で Source を「Deploy from a branch」、Branch を `master` / `/ (root)` にする。

## オンライン対戦の仕組み

- GitHub Pages は静的ファイルのみ配信するため、通信には [PeerJS](https://peerjs.com/)(WebRTC による P2P 通信)を使用
- 接続相手を探すシグナリングには PeerJS の無料公開クラウドサーバー(`0.peerjs.com`)を使用。アカウント登録は不要
- ルームキーは SHA-256 でハッシュ化した値を接続 ID に使用。先に入室した人がホストになる
- 公開 PeerJS サーバーは無保証のため、混雑や停止で接続できないことがある。また一部のネットワークでは P2P 接続が確立できない場合がある(TURN サーバー未使用のため)

### Hit & Blow 5 の不正対策

自分の秘密の数字は相手に送らず、手元で Hit/Blow を判定して結果だけを返す。決着後にお互いの数字を公開し、判定結果に食い違いがないかを自動でチェックする。

## 将棋の CPU について

| 強さ | エンジン | 設定 |
|---|---|---|
| 簡単 | やねうら王 + SuishoPetite(K-P) | 深さ1・候補8手から確率で選ぶ |
| 普通 | 同上 | 深さ3・候補4手から確率で選ぶ |
| 難しい | 同上 | 1手1秒・最善手 |
| 最強 | やねうら王 + 水匠5(NNUE HalfKP) | 最大3/5/10/20秒・最善手・相手の手番中も先読み(ponder)・CPU コア数−1 スレッド |
| 極 | 最強 + KomoringHeights + 定跡 | 最強の設定に加えて、詰将棋ソルバーを並列実行(詰みが見つかれば即座に詰ます)、水匠5に1局面30秒×4スレッドで読ませて作った定跡、置換表を最大1GBに拡大 |

- エンジンは [@mizarjp/yaneuraou.k-p](https://www.npmjs.com/package/@mizarjp/yaneuraou.k-p) 7.6.3-alpha.0 と [@mizarjp/yaneuraou.halfkp](https://www.npmjs.com/package/@mizarjp/yaneuraou.halfkp) 7.6.2-alpha.2 のビルドをそのまま同梱(wasm は gzip 圧縮し、ブラウザの DecompressionStream で展開)
- WebAssembly のスレッドに SharedArrayBuffer が必要なため、`shogi/coi-sw.js`(Service Worker)で COOP/COEP ヘッダーを付けている
- 最強・極の初回読み込みは約 30MB
- 形勢バー: 最強・極では CPU 自身の読みの評価値、それ以外のモード(簡単〜難しい・オンライン・ふたりで対局)は K-P 版エンジンを別インスタンスで動かして評価。勝率は 1/(1+exp(-評価値/600)) で換算した目安
- ヒント(CPU 対戦のみ): 形勢バー用の K-P 版エンジンが 1.5 秒読んだ推奨手を盤上に表示(強さは「難しい」相当)。CPU の思考とは別インスタンスなので、最強・極の先読みを邪魔しない
- 定跡 `shogi/engine/book-suisho5.db` は YaneuraOu の定跡 DB 形式。CPU が先手・後手それぞれの主要な序盤(人間側は水匠5の上位3手+よく指される手)を数手分収録

### ライセンス

- やねうら王: GPLv3(`shogi/engine/LICENSE.md`)。ソースコード: <https://github.com/yaneurao/YaneuraOu> / WebAssembly 版: <https://github.com/mizar/YaneuraOu>
- 評価関数 水匠5 / SuishoPetite: たややん氏(上記 npm パッケージに同梱されたもの)
- KomoringHeights: GPLv3。ソースコード: <https://github.com/komori-n/KomoringHeights>([@mizarjp/yaneuraou.komoringheights-mate](https://www.npmjs.com/package/@mizarjp/yaneuraou.komoringheights-mate) 0.5.0-kh.14 のビルドを同梱)
- PeerJS: MIT

## 将棋 AI 対戦場(`/shogi/arena/`)

AI(Claude・ChatGPT・Gemini など)に書かせた将棋ボットを持ち込んで戦わせるページ。

- **ボットの仕様**: [`shogi/arena/BOT_SPEC.md`](shogi/arena/BOT_SPEC.md)。この仕様書を AI に渡して「この仕様で将棋ボットを書いて」と頼むと、そのまま使える `.js` ファイルが作れる(ページ上の「仕様書をコピー」からも取れる)
- **持ち込み方(2通り)**
  - `shogi/arena/bots/` にファイルを置いて push する → 公開サイトに常設。ページは GitHub API でフォルダの中身を読むので、置くだけで一覧に出る(API が使えないときは `bots/index.json` を使う。これは GitHub Actions `.github/workflows/arena-bots.yml` が自動更新、手元では `node tools/build-bot-manifest.mjs`)
  - ページの枠にファイルをドロップ → そのブラウザの中だけで使える(ブラウザに保存される)
- **安全対策**: ボットは Web Worker の中で動くので画面やページのデータに触れない。持ち時間+0.5秒を超えたら強制終了して負け。反則手・例外も負け。読み込み時に初手を指せるか確認する
- **内蔵 CPU**(簡単〜極)も参加できる(相手の手番中の先読みは切って条件を揃える)
- 同梱のサンプル: `random.js`(テンプレート)、`claude-greedy.js`・`claude-alphabeta.js`(Claude 作)
- `claude-honki.js`「Claude 本気」: Claude が一から書いた将棋エンジン(既存のエンジン・評価関数・学習済みモデル・棋譜は不使用)
  - 独自の盤表現と合法手生成(対戦場の判定と 7,703 局面で一致、perft(4)=719,731)
  - αβ探索(PVS・置換表・null move・LMR・futility/LMP・キラー/ヒストリー・王手延長)+ 静止探索 + 一手詰め判定 + 千日手/連続王手の判定
  - 評価関数: 駒割り・玉との相対位置・大駒の利き・玉の周りの安全度など。自分自身との対局(約15万局面)から学習
  - 1手1秒で: CPU 簡単 4勝0敗 / 普通 6勝0敗 / 難しい 0勝12敗 / Claude αβ 4勝0敗
