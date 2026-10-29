/*
 * Claude 本気 — Claude が一から書いた将棋エンジン(AI 対戦場 v1 のボット)
 *
 * 既存のエンジン・評価関数・学習済みモデルは使っていない。使っているのは一般に知られた手法だけ:
 *   盤      : 11×13 の番兵つき配列、Zobrist ハッシュ、差分更新の make / unmake
 *   探索    : 反復深化 + PVS(αβ)+ 置換表 + null move pruning + LMR + futility / late move pruning
 *             + キラー / ヒストリーによる手の並べ替え + 王手延長 + 静止探索 + 千日手・連続王手の判定
 *   評価    : 駒割り + 「駒種 × 相手玉・自玉からの相対位置」の表(攻め・守り)+ 玉の位置
 *             初期値は手で決め、自己対局の結果から調整(Texel 法)
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 盤の表現
  // ---------------------------------------------------------------------------
  const W = 11;                 // 横: 9 + 左右の番兵
  const NSQ = W * 13;           // 縦: 9 + 上下2段ずつの番兵(桂馬用)
  const WALL = 64;
  const WHITE = 16;             // 後手の駒は駒種 | 16
  const P = 1, L = 2, N = 3, S = 4, G = 5, B = 6, R = 7, K = 8; // 成り駒は +8(+P=9 … +B=14, +R=15)
  const HAND_ORDER = [R, B, G, S, N, L, P];
  const PIECE_CHARS = ' PLNSGBRK';

  const SQ81 = new Int32Array(81);
  const ROW = new Int8Array(NSQ).fill(-1);
  const COL = new Int8Array(NSQ).fill(-1);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const s = (r + 2) * W + c + 1;
      SQ81[r * 9 + c] = s;
      ROW[s] = r;
      COL[s] = c;
    }
  }

  // 方向(先手から見て。上 = 後手陣の方向)
  const UP = -W, DN = W, LT = -1, RT = 1, UL = -W - 1, UR = -W + 1, DL = W - 1, DR = W + 1;
  const DIRS8 = [UP, UR, RT, DR, DN, DL, LT, UL];
  const GOLD = [UL, UP, UR, LT, RT, DN];
  const STEP_BLACK = {
    1: [UP], 2: [], 3: [2 * UP + LT, 2 * UP + RT], 4: [UL, UP, UR, DL, DR], 5: GOLD, 6: [], 7: [],
    8: [UP, UR, RT, DR, DN, DL, LT, UL], 9: GOLD, 10: GOLD, 11: GOLD, 12: GOLD, 14: [UP, DN, LT, RT], 15: [UL, UR, DL, DR],
  };
  const SLIDE_BLACK = { 2: [UP], 6: [UL, UR, DL, DR], 7: [UP, DN, LT, RT], 14: [UL, UR, DL, DR], 15: [UP, DN, LT, RT] };

  const STEPS = [];
  const SLIDES = [];
  const STEP_ATK = new Uint8Array(32 * 8);
  const SLIDE_ATK = new Uint8Array(32 * 8);
  for (let pc = 0; pc < 32; pc++) {
    const t = pc & 15;
    const sign = pc & WHITE ? -1 : 1;
    const st = (STEP_BLACK[t] || []).map((o) => o * sign);
    const sl = (SLIDE_BLACK[t] || []).map((o) => o * sign);
    STEPS[pc] = Int32Array.from(st);
    SLIDES[pc] = Int32Array.from(sl);
    for (let i = 0; i < 8; i++) {
      if (st.includes(DIRS8[i])) STEP_ATK[pc * 8 + i] = 1;
      if (sl.includes(DIRS8[i])) SLIDE_ATK[pc * 8 + i] = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Zobrist ハッシュ(下位・上位 32bit の2本)
  // ---------------------------------------------------------------------------
  let seed = 0x2545f491;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed | 0;
  };
  const ZB_LO = new Int32Array(32 * NSQ), ZB_HI = new Int32Array(32 * NSQ);
  for (let i = 0; i < ZB_LO.length; i++) { ZB_LO[i] = rnd(); ZB_HI[i] = rnd(); }
  const ZH_LO = new Int32Array(16 * 20), ZH_HI = new Int32Array(16 * 20); // (手番*8+駒種)*20 + 枚数
  for (let i = 0; i < ZH_LO.length; i++) { ZH_LO[i] = rnd(); ZH_HI[i] = rnd(); }
  const ZS_LO = rnd(), ZS_HI = rnd();

  // ---------------------------------------------------------------------------
  // 局面
  // ---------------------------------------------------------------------------
  const board = new Int8Array(NSQ);
  const hands = new Int8Array(16);
  const kingSq = new Int32Array(2);
  const pawnFiles = new Int32Array(2); // 歩のある筋(二歩判定)
  let side = 0;
  let keyLo = 0, keyHi = 0;
  let mat = 0; // 駒割り(先手 − 後手)

  // 駒の価値(盤上 / 持ち駒)
  const BOARD_V = new Int32Array(16); // 評価パラメータから設定
  const HAND_V = new Int32Array(8);

  const MAX_SP = 1024;
  const U_CAP = new Int8Array(MAX_SP);
  const U_KLO = new Int32Array(MAX_SP), U_KHI = new Int32Array(MAX_SP);
  const U_PF0 = new Int32Array(MAX_SP), U_PF1 = new Int32Array(MAX_SP), U_MAT = new Int32Array(MAX_SP);
  let sp = 0;

  const isOwn = (pc, us) => (us ? pc > 16 && pc < 32 : pc > 0 && pc < 16);

  function fullKey() {
    let lo = 0, hi = 0;
    for (let i = 0; i < 81; i++) {
      const s = SQ81[i], pc = board[s];
      if (pc) { lo ^= ZB_LO[pc * NSQ + s]; hi ^= ZB_HI[pc * NSQ + s]; }
    }
    for (let c = 0; c < 2; c++) {
      for (let t = 1; t <= 7; t++) {
        const h = (c * 8 + t) * 20 + hands[c * 8 + t];
        lo ^= ZH_LO[h]; hi ^= ZH_HI[h];
      }
    }
    if (side) { lo ^= ZS_LO; hi ^= ZS_HI; }
    keyLo = lo; keyHi = hi;
  }

  function fullMaterial() {
    let m = 0;
    for (let i = 0; i < 81; i++) {
      const pc = board[SQ81[i]];
      if (pc) m += (pc & WHITE ? -1 : 1) * BOARD_V[pc & 15];
    }
    for (let t = 1; t <= 7; t++) m += (hands[t] - hands[8 + t]) * HAND_V[t];
    mat = m;
  }

  function setSfen(sfen) {
    board.fill(WALL);
    for (let i = 0; i < 81; i++) board[SQ81[i]] = 0;
    hands.fill(0);
    pawnFiles[0] = pawnFiles[1] = 0;
    const [b, s, h] = sfen.trim().split(/\s+/);
    let r = 0, c = 0, prom = false;
    for (const ch of b) {
      if (ch === '/') { r++; c = 0; continue; }
      if (ch === '+') { prom = true; continue; }
      if (ch >= '1' && ch <= '9') { c += Number(ch); continue; }
      const up = ch.toUpperCase();
      let t = PIECE_CHARS.indexOf(up);
      if (prom) t += 8;
      prom = false;
      const white = ch !== up;
      const sq = SQ81[r * 9 + c];
      board[sq] = t | (white ? WHITE : 0);
      if (t === K) kingSq[white ? 1 : 0] = sq;
      if (t === P) pawnFiles[white ? 1 : 0] |= 1 << c;
      c++;
    }
    side = s === 'w' ? 1 : 0;
    if (h && h !== '-') {
      let n = 0;
      for (const ch of h) {
        if (ch >= '0' && ch <= '9') { n = n * 10 + Number(ch); continue; }
        const up = ch.toUpperCase();
        hands[(ch === up ? 0 : 8) + PIECE_CHARS.indexOf(up)] += n || 1;
        n = 0;
      }
    }
    sp = 0;
    fullKey();
    fullMaterial();
  }

  // 指し手: to | from << 8 | 打つ駒種 << 16 | 成り << 20
  const mTo = (m) => m & 255;
  const mFrom = (m) => (m >>> 8) & 255;
  const mDrop = (m) => (m >>> 16) & 15;
  const mProm = (m) => (m >>> 20) & 1;

  function makeMove(m) {
    const to = m & 255, from = (m >>> 8) & 255, dt = (m >>> 16) & 15;
    const us = side, sign = us ? -1 : 1;
    U_KLO[sp] = keyLo; U_KHI[sp] = keyHi; U_PF0[sp] = pawnFiles[0]; U_PF1[sp] = pawnFiles[1]; U_MAT[sp] = mat;
    if (dt) {
      const pc = dt | (us << 4);
      const hi = us * 8 + dt, n = hands[hi];
      keyLo ^= ZH_LO[hi * 20 + n] ^ ZH_LO[hi * 20 + n - 1];
      keyHi ^= ZH_HI[hi * 20 + n] ^ ZH_HI[hi * 20 + n - 1];
      hands[hi] = n - 1;
      board[to] = pc;
      keyLo ^= ZB_LO[pc * NSQ + to]; keyHi ^= ZB_HI[pc * NSQ + to];
      if (dt === P) pawnFiles[us] |= 1 << COL[to];
      mat += sign * (BOARD_V[dt] - HAND_V[dt]);
      U_CAP[sp] = 0;
    } else {
      const pc = board[from], cap = board[to];
      U_CAP[sp] = cap;
      if (cap) {
        const ct = cap & 15, bt = ct > 8 ? ct - 8 : ct;
        keyLo ^= ZB_LO[cap * NSQ + to]; keyHi ^= ZB_HI[cap * NSQ + to];
        const hi = us * 8 + bt, n = hands[hi];
        keyLo ^= ZH_LO[hi * 20 + n] ^ ZH_LO[hi * 20 + n + 1];
        keyHi ^= ZH_HI[hi * 20 + n] ^ ZH_HI[hi * 20 + n + 1];
        hands[hi] = n + 1;
        if (ct === P) pawnFiles[us ^ 1] &= ~(1 << COL[to]);
        mat += sign * (BOARD_V[ct] + HAND_V[bt]);
      }
      keyLo ^= ZB_LO[pc * NSQ + from]; keyHi ^= ZB_HI[pc * NSQ + from];
      board[from] = 0;
      let np = pc;
      if (m & 0x100000) {
        np = pc + 8;
        const t = pc & 15;
        mat += sign * (BOARD_V[t + 8] - BOARD_V[t]);
        if (t === P) pawnFiles[us] &= ~(1 << COL[from]);
      }
      board[to] = np;
      keyLo ^= ZB_LO[np * NSQ + to]; keyHi ^= ZB_HI[np * NSQ + to];
      if ((pc & 15) === K) kingSq[us] = to;
    }
    side = us ^ 1;
    keyLo ^= ZS_LO; keyHi ^= ZS_HI;
    sp++;
  }

  function unmakeMove(m) {
    sp--;
    side ^= 1;
    const us = side;
    const to = m & 255, from = (m >>> 8) & 255, dt = (m >>> 16) & 15;
    if (dt) {
      board[to] = 0;
      hands[us * 8 + dt]++;
    } else {
      const np = board[to];
      const pc = m & 0x100000 ? np - 8 : np;
      board[from] = pc;
      const cap = U_CAP[sp];
      board[to] = cap;
      if (cap) {
        const ct = cap & 15;
        hands[us * 8 + (ct > 8 ? ct - 8 : ct)]--;
      }
      if ((pc & 15) === K) kingSq[us] = from;
    }
    keyLo = U_KLO[sp]; keyHi = U_KHI[sp];
    pawnFiles[0] = U_PF0[sp]; pawnFiles[1] = U_PF1[sp];
    mat = U_MAT[sp];
  }

  function makeNull() {
    U_KLO[sp] = keyLo; U_KHI[sp] = keyHi;
    side ^= 1;
    keyLo ^= ZS_LO; keyHi ^= ZS_HI;
    sp++;
  }

  function unmakeNull() {
    sp--;
    side ^= 1;
    keyLo = U_KLO[sp]; keyHi = U_KHI[sp];
  }

  /** マス s に by 側の駒が利いているか */
  function isAttacked(s, by) {
    const lo = by ? 16 : 0, hi = lo + 16;
    for (let i = 0; i < 8; i++) {
      const o = DIRS8[i];
      let t = s - o;
      let pc = board[t];
      if (pc === 0) {
        do { t -= o; pc = board[t]; } while (pc === 0);
        if (pc > lo && pc < hi && SLIDE_ATK[pc * 8 + i]) return true;
      } else if (pc > lo && pc < hi && (STEP_ATK[pc * 8 + i] | SLIDE_ATK[pc * 8 + i])) {
        return true;
      }
    }
    if (by === 0) return board[s + 2 * W - 1] === N || board[s + 2 * W + 1] === N;
    return board[s - 2 * W - 1] === (N | WHITE) || board[s - 2 * W + 1] === (N | WHITE);
  }

  const inCheck = () => isAttacked(kingSq[side], side ^ 1);

  // ---------------------------------------------------------------------------
  // 指し手生成(自玉の安全は確認しない。確認は make 後に行う)
  // ---------------------------------------------------------------------------
  let GEN_ALL = false; // true: 歩・角・飛の不成も生成(テスト用)

  function addMove(buf, idx, from, to, t, us) {
    const rf = us ? 8 - ROW[from] : ROW[from];
    const rt = us ? 8 - ROW[to] : ROW[to];
    const base = to | (from << 8);
    if (t <= 7 && t !== G && (rf <= 2 || rt <= 2)) {
      buf[idx++] = base | 0x100000;
      if (t === P || t === B || t === R) {
        if (GEN_ALL && !(t === P && rt === 0)) buf[idx++] = base;
        return idx;
      }
      if ((t === L && rt === 0) || (t === N && rt <= 1)) return idx;
    }
    buf[idx++] = base;
    return idx;
  }

  function genMoves(buf, idx, capsOnly) {
    const us = side, lo = us ? 16 : 0, hi = lo + 16, oLo = us ? 0 : 16, oHi = oLo + 16;
    for (let i = 0; i < 81; i++) {
      const from = SQ81[i], pc = board[from];
      if (pc <= lo || pc >= hi) continue;
      const t = pc & 15;
      const st = STEPS[pc];
      for (let k = 0; k < st.length; k++) {
        const to = from + st[k], tp = board[to];
        if (tp === 0) { if (!capsOnly) idx = addMove(buf, idx, from, to, t, us); } else if (tp > oLo && tp < oHi) idx = addMove(buf, idx, from, to, t, us);
      }
      const sl = SLIDES[pc];
      for (let k = 0; k < sl.length; k++) {
        const o = sl[k];
        let to = from + o;
        while (board[to] === 0) {
          if (!capsOnly) idx = addMove(buf, idx, from, to, t, us);
          to += o;
        }
        const tp = board[to];
        if (tp > oLo && tp < oHi) idx = addMove(buf, idx, from, to, t, us);
      }
    }
    if (!capsOnly) idx = genDrops(buf, idx);
    return idx;
  }

  function genDrops(buf, idx) {
    const us = side, h = us * 8;
    const hp = hands[h + P], hl = hands[h + L], hn = hands[h + N], hs = hands[h + S], hg = hands[h + G], hb = hands[h + B], hr = hands[h + R];
    if (!(hp | hl | hn | hs | hg | hb | hr)) return idx;
    const pf = pawnFiles[us];
    for (let i = 0; i < 81; i++) {
      const to = SQ81[i];
      if (board[to] !== 0) continue;
      const r = us ? 8 - ROW[to] : ROW[to];
      if (hp && r > 0 && !(pf & (1 << COL[to]))) buf[idx++] = to | (P << 16);
      if (hl && r > 0) buf[idx++] = to | (L << 16);
      if (hn && r > 1) buf[idx++] = to | (N << 16);
      if (hs) buf[idx++] = to | (S << 16);
      if (hg) buf[idx++] = to | (G << 16);
      if (hb) buf[idx++] = to | (B << 16);
      if (hr) buf[idx++] = to | (R << 16);
    }
    return idx;
  }

  /** 直前の手が打ち歩詰めか(歩を玉の正面に打って王手した場合だけ調べる) */
  function isPawnDropMate(m) {
    if (mDrop(m) !== P) return false;
    const to = m & 255;
    const mover = side ^ 1;
    if ((mover === 0 ? to + UP : to + DN) !== kingSq[side]) return false;
    return !hasLegalMove();
  }

  const SCRATCH = new Int32Array(1024);
  function hasLegalMove() {
    const n = genMoves(SCRATCH, 0, false);
    const us = side;
    for (let i = 0; i < n; i++) {
      const m = SCRATCH[i];
      makeMove(m);
      const ok = !isAttacked(kingSq[us], us ^ 1);
      unmakeMove(m);
      if (ok) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 評価関数(すべて先手から見た値。パラメータは自己対局で学習)
  //   MB: 盤上の駒の価値 [駒種]            MH: 持ち駒の価値 [駒種]
  //   A : 攻め [駒種][相手玉からの相対位置 dy(-8..8) × |dx|(0..8)]
  //   D : 守り [駒種][自玉からの相対位置]
  //   PS: 駒の位置 [駒種][自陣から見た段 × 端からの距離(左右対称)]
  //   KP: 玉の位置 [段 × 端からの距離]   HK: 持ち駒 × 相手玉の段
  // ---------------------------------------------------------------------------
  const REL = 153;
  const OFF_MB = 0, OFF_MH = 16, OFF_A = 24, OFF_D = OFF_A + 16 * REL, OFF_PS = OFF_D + 16 * REL;
  const OFF_K = OFF_PS + 16 * 45, OFF_HK = OFF_K + 45;
  const N_PARAMS = OFF_HK + 8 * 9;
  const EV = new Int16Array(N_PARAMS);
  const relIdx = (dy, adx) => (dy + 8) * 9 + adx;
  const edge = (c) => (c > 4 ? 8 - c : c);

  function syncMaterial() {
    for (let t = 0; t < 16; t++) BOARD_V[t] = EV[OFF_MB + t];
    for (let t = 0; t < 8; t++) HAND_V[t] = EV[OFF_MH + t];
  }

  function initEval() {
    const mb = [0, 90, 250, 280, 400, 480, 600, 700, 0, 520, 500, 510, 500, 0, 850, 1000];
    const mh = [0, 100, 290, 320, 450, 540, 700, 820];
    mb.forEach((v, t) => { EV[OFF_MB + t] = v; });
    mh.forEach((v, t) => { EV[OFF_MH + t] = v; });
    const atkW = [0, 15, 20, 40, 60, 60, 40, 50, 0, 60, 60, 60, 60, 0, 70, 90];
    const atkF = [0, 1, 0.6, 0.25];
    for (let t = 1; t < 16; t++) {
      if (t === K || t === 13) continue;
      for (let dy = -8; dy <= 8; dy++) {
        for (let adx = 0; adx <= 8; adx++) {
          const d = Math.max(Math.abs(dy), adx);
          EV[OFF_A + t * REL + relIdx(dy, adx)] = Math.round(atkW[t] * (atkF[d] || 0));
          let def = 0;
          const goldLike = t === G || t === S || (t >= 9 && t <= 12);
          if (goldLike) def = d === 1 ? (t === S ? 40 : 50) : d === 2 ? 25 : 0;
          if (t === P && dy < 0 && dy >= -3 && adx <= 1) def = 15;
          if (t === R && d <= 2) def = -30;
          EV[OFF_D + t * REL + relIdx(dy, adx)] = def;
        }
      }
    }
    const rowV = [-200, -200, -200, -200, -150, -90, -40, -10, 0];
    const colV = [0, 10, 10, 0, -20];
    for (let r = 0; r < 9; r++) for (let a = 0; a < 5; a++) EV[OFF_K + r * 5 + a] = rowV[r] + colV[a];
    syncMaterial();
  }

  /** 学習済みパラメータ(なければ初期値のまま) */
  const TUNED = null; // @@TUNED@@
  initEval();
  if (TUNED) { for (let i = 0; i < N_PARAMS; i++) EV[i] = TUNED[i]; syncMaterial(); }

  function evaluate() {
    let sc = mat;
    const kb = kingSq[0], kw = kingSq[1];
    const rb = ROW[kb], cb = COL[kb], rw = ROW[kw], cw = COL[kw];
    for (let i = 0; i < 81; i++) {
      const s = SQ81[i], pc = board[s];
      if (pc === 0) continue;
      const r = ROW[s], c = COL[s];
      const e = c > 4 ? 8 - c : c;
      if (pc < 16) {
        if (pc === K) continue;
        const base = pc * REL;
        const dxw = c > cw ? c - cw : cw - c, dxb = c > cb ? c - cb : cb - c;
        sc += EV[OFF_A + base + (r - rw + 8) * 9 + dxw] + EV[OFF_D + base + (r - rb + 8) * 9 + dxb] + EV[OFF_PS + pc * 45 + r * 5 + e];
      } else {
        const t = pc & 15;
        if (t === K) continue;
        const base = t * REL;
        const dxb = c > cb ? c - cb : cb - c, dxw = c > cw ? c - cw : cw - c;
        sc -= EV[OFF_A + base + (rb - r + 8) * 9 + dxb] + EV[OFF_D + base + (rw - r + 8) * 9 + dxw] + EV[OFF_PS + t * 45 + (8 - r) * 5 + e];
      }
    }
    sc += EV[OFF_K + rb * 5 + edge(cb)] - EV[OFF_K + (8 - rw) * 5 + edge(cw)];
    for (let t = 1; t <= 7; t++) {
      sc += hands[t] * EV[OFF_HK + t * 9 + rw] - hands[8 + t] * EV[OFF_HK + t * 9 + (8 - rb)];
    }
    return side ? -sc : sc;
  }

  /** 学習用: evaluate() と同じ値を (パラメータ番号, 係数) の組で書き出す(先手から見た値) */
  function extractFeatures(idx, coef) {
    let n = 0;
    const add = (i, c) => { idx[n] = i; coef[n] = c; n++; };
    const kb = kingSq[0], kw = kingSq[1];
    const rb = ROW[kb], cb = COL[kb], rw = ROW[kw], cw = COL[kw];
    for (let i = 0; i < 81; i++) {
      const s = SQ81[i], pc = board[s];
      if (pc === 0) continue;
      const r = ROW[s], c = COL[s], e = edge(c);
      const t = pc & 15;
      if (t === K) continue;
      if (pc < 16) {
        add(OFF_MB + t, 1);
        add(OFF_A + t * REL + (r - rw + 8) * 9 + Math.abs(c - cw), 1);
        add(OFF_D + t * REL + (r - rb + 8) * 9 + Math.abs(c - cb), 1);
        add(OFF_PS + t * 45 + r * 5 + e, 1);
      } else {
        add(OFF_MB + t, -1);
        add(OFF_A + t * REL + (rb - r + 8) * 9 + Math.abs(c - cb), -1);
        add(OFF_D + t * REL + (rw - r + 8) * 9 + Math.abs(c - cw), -1);
        add(OFF_PS + t * 45 + (8 - r) * 5 + e, -1);
      }
    }
    add(OFF_K + rb * 5 + edge(cb), 1);
    add(OFF_K + (8 - rw) * 5 + edge(cw), -1);
    for (let t = 1; t <= 7; t++) {
      if (hands[t]) { add(OFF_MH + t, hands[t]); add(OFF_HK + t * 9 + rw, hands[t]); }
      if (hands[8 + t]) { add(OFF_MH + t, -hands[8 + t]); add(OFF_HK + t * 9 + (8 - rb), -hands[8 + t]); }
    }
    return n;
  }

  function loadParams(arr) {
    for (let i = 0; i < N_PARAMS; i++) EV[i] = arr[i];
    syncMaterial();
    fullMaterial();
  }

  // ---------------------------------------------------------------------------
  // 探索
  // ---------------------------------------------------------------------------
  const INF = 32000, MATE = 31000, MATE_BOUND = 30000, WIN = 29000;
  const MAX_PLY = 96;
  const MAX_MOVES = 600;
  const MOVES = new Int32Array(MAX_PLY * MAX_MOVES);
  const SCORES = new Int32Array(MAX_PLY * MAX_MOVES);
  const KILLER1 = new Int32Array(MAX_PLY), KILLER2 = new Int32Array(MAX_PLY);
  const HISTORY = new Int32Array(2 * 16 * NSQ); // [手番][駒種][移動先]
  const QUIETS = new Int32Array(MAX_PLY * 64);   // 各 ply で試した静かな手

  // 置換表
  const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const ttKey = new Int32Array(TT_SIZE);
  const ttMove = new Int32Array(TT_SIZE);
  const ttScore = new Int16Array(TT_SIZE);
  const ttDepth = new Int8Array(TT_SIZE);
  const ttFlag = new Uint8Array(TT_SIZE); // 1: exact 2: lower 3: upper
  const EXACT = 1, LOWER = 2, UPPER = 3;

  // 千日手判定用: 対局開始からの局面のハッシュと、その局面で手番側が王手されていたか
  const HIST_LO = new Int32Array(2048), HIST_HI = new Int32Array(2048);
  const HIST_CHK = new Uint8Array(2048);
  let hp = 0;

  // LMR の減らす量
  const LMR = new Int8Array(64 * 64);
  for (let d = 1; d < 64; d++) for (let n = 1; n < 64; n++) LMR[d * 64 + n] = Math.floor(0.5 + Math.log(d) * Math.log(n) / 2.2);

  let nodes = 0;
  let stopped = false;
  let hardDeadline = 0;
  let now = () => Date.now();

  function checkTime() {
    if (now() >= hardDeadline) stopped = true;
  }

  const scoreToTT = (v, ply) => (v >= MATE_BOUND ? v + ply : v <= -MATE_BOUND ? v - ply : v);
  const scoreFromTT = (v, ply) => (v >= MATE_BOUND ? v - ply : v <= -MATE_BOUND ? v + ply : v);

  function pieceTypeOf(m) {
    const dt = mDrop(m);
    return dt || (board[mFrom(m)] & 15);
  }

  function orderMoves(base, n, ttm, ply) {
    const us = side;
    const k1 = KILLER1[ply], k2 = KILLER2[ply];
    for (let i = 0; i < n; i++) {
      const m = MOVES[base + i];
      let s;
      if (m === ttm) s = 10000000;
      else {
        const cap = mDrop(m) ? 0 : board[m & 255];
        if (cap) {
          const av = BOARD_V[board[mFrom(m)] & 15], vv = BOARD_V[cap & 15];
          s = 5000000 + vv * 16 - av / 8;
          // 価値の高い駒で守られた駒を取る手は後回し
          if (av > vv + 50 && !(m & 0x100000) && isAttacked(m & 255, us ^ 1)) s -= 4000000;
        }
        else if (m & 0x100000) s = 4000000 + BOARD_V[(board[mFrom(m)] & 15) + 8];
        else if (m === k1) s = 3000000;
        else if (m === k2) s = 2900000;
        else s = HISTORY[(us * 16 + pieceTypeOf(m)) * NSQ + (m & 255)];
      }
      SCORES[base + i] = s;
    }
  }

  /** base..base+n の中で i 番目以降の最善を i 番目に持ってくる */
  function pickNext(base, i, n) {
    let bi = i, bs = SCORES[base + i];
    for (let j = i + 1; j < n; j++) {
      if (SCORES[base + j] > bs) { bs = SCORES[base + j]; bi = j; }
    }
    if (bi !== i) {
      const tm = MOVES[base + i]; MOVES[base + i] = MOVES[base + bi]; MOVES[base + bi] = tm;
      const ts = SCORES[base + i]; SCORES[base + i] = SCORES[base + bi]; SCORES[base + bi] = ts;
    }
    return MOVES[base + i];
  }

  /** 千日手: 同一局面が過去にあれば、連続王手かどうかで勝ち・負け・引き分けを返す(なければ null) */
  function repetitionScore() {
    const lim = Math.max(0, hp - 64);
    for (let i = hp - 4; i >= lim; i -= 2) {
      if (HIST_LO[i] === keyLo && HIST_HI[i] === keyHi) {
        // 手番側(今の局面と同じ側)の局面がすべて王手 → 相手が王手をかけ続けている
        let oppChecking = true, usChecking = true;
        for (let j = i + 2; j <= hp; j += 2) if (!HIST_CHK[j]) { oppChecking = false; break; }
        for (let j = i + 1; j < hp; j += 2) if (!HIST_CHK[j]) { usChecking = false; break; }
        if (oppChecking) return WIN;
        if (usChecking) return -WIN;
        return 0;
      }
    }
    return null;
  }

  function qsearch(alpha, beta, ply, qd) {
    if ((++nodes & 2047) === 0) checkTime();
    if (stopped) return 0;
    const chk = inCheck();
    let best;
    const base = ply * MAX_MOVES;
    let n;
    if (!chk) {
      const stand = evaluate();
      if (stand >= beta) return stand;
      if (qd >= 10 || ply >= MAX_PLY - 2) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
      n = genMoves(MOVES, base, true) - base;
    } else {
      if (qd >= 6 || ply >= MAX_PLY - 2) return evaluate();
      best = -INF;
      n = genMoves(MOVES, base, false) - base;
    }
    orderMoves(base, n, 0, ply);
    const us = side;
    let legal = 0;
    for (let i = 0; i < n; i++) {
      const m = pickNext(base, i, n);
      if (!chk) {
        // 取っても届かない手は読まない(delta pruning)
        const cap = board[m & 255] & 15;
        const gain = BOARD_V[cap] + HAND_V[cap > 8 ? cap - 8 : cap] + (m & 0x100000 ? 300 : 0);
        if (best + gain + 150 < alpha) continue;
        // 取り返されて損をする取り(高い駒で守られた安い駒を取る)は読まない
        if (!(m & 0x100000) && BOARD_V[board[mFrom(m)] & 15] > BOARD_V[cap] + 50 && isAttacked(m & 255, us ^ 1)) continue;
      }
      makeMove(m);
      if (isAttacked(kingSq[us], us ^ 1)) { unmakeMove(m); continue; }
      if (chk && isPawnDropMate(m)) { unmakeMove(m); continue; }
      legal++;
      const v = -qsearch(-beta, -alpha, ply + 1, qd + 1);
      unmakeMove(m);
      if (stopped) return 0;
      if (v > best) {
        best = v;
        if (v > alpha) {
          alpha = v;
          if (v >= beta) return v;
        }
      }
    }
    if (chk && legal === 0) return -MATE + ply;
    return best;
  }

  function search(depth, alpha, beta, ply, pvNode, allowNull) {
    if ((++nodes & 2047) === 0) checkTime();
    if (stopped) return 0;

    // 詰みまでの距離で枝を刈る
    const mAlpha = Math.max(alpha, -MATE + ply), mBeta = Math.min(beta, MATE - ply - 1);
    if (mAlpha >= mBeta) return mAlpha;

    const chk = inCheck();
    HIST_LO[hp] = keyLo; HIST_HI[hp] = keyHi; HIST_CHK[hp] = chk ? 1 : 0;
    const rep = repetitionScore();
    if (rep !== null) return rep;
    if (depth <= 0) return qsearch(alpha, beta, ply, 0);
    if (ply >= MAX_PLY - 2) return evaluate();

    // 置換表
    const ti = keyLo & TT_MASK;
    let ttm = 0;
    if (ttKey[ti] === keyHi && ttFlag[ti]) {
      ttm = ttMove[ti];
      if (!pvNode && ttDepth[ti] >= depth) {
        const v = scoreFromTT(ttScore[ti], ply);
        const f = ttFlag[ti];
        if (f === EXACT || (f === LOWER && v >= beta) || (f === UPPER && v <= alpha)) return v;
      }
    }

    const staticEval = chk ? -INF : evaluate();
    if (!pvNode && !chk) {
      // 静的評価が大きく上回るなら打ち切る(reverse futility)
      if (depth <= 4 && staticEval - 120 * depth >= beta && Math.abs(beta) < MATE_BOUND) return staticEval;
      // null move pruning
      if (allowNull && depth >= 3 && staticEval >= beta) {
        const Rn = 3 + (depth >= 8 ? 1 : 0);
        makeNull();
        hp++;
        const v = -search(depth - 1 - Rn, -beta, -beta + 1, ply + 1, false, false);
        hp--;
        unmakeNull();
        if (stopped) return 0;
        if (v >= beta) return v >= MATE_BOUND ? beta : v;
      }
    }

    // 内部反復深化: 置換表の手がないときは浅く読んで並べ替えに使う
    if (!ttm && pvNode && depth >= 5) {
      search(depth - 3, alpha, beta, ply, pvNode, false);
      if (ttKey[ti] === keyHi) ttm = ttMove[ti];
    }

    const base = ply * MAX_MOVES;
    const n = genMoves(MOVES, base, false) - base;
    orderMoves(base, n, ttm, ply);

    const us = side;
    const origAlpha = alpha;
    let best = -INF, bestMove = 0, legal = 0, quietsTried = 0;
    const qbase = ply * 64;
    for (let i = 0; i < n; i++) {
      const m = pickNext(base, i, n);
      const isCap = !mDrop(m) && board[m & 255] !== 0;
      const isProm = (m & 0x100000) !== 0;
      makeMove(m);
      if (isAttacked(kingSq[us], us ^ 1)) { unmakeMove(m); continue; }
      const givesCheck = inCheck();
      if (givesCheck && isPawnDropMate(m)) { unmakeMove(m); continue; }
      legal++;
      const quiet = !isCap && !isProm;
      if (quiet) {
        if (quietsTried < 64) QUIETS[qbase + quietsTried] = m;
        quietsTried++;
      }

      // 浅いところで見込みのない静かな手を刈る
      if (!pvNode && !chk && !givesCheck && quiet && legal > 1 && best > -MATE_BOUND) {
        if (depth <= 3 && staticEval + 100 + 150 * depth <= alpha) { unmakeMove(m); continue; }
        if (depth <= 4 && quietsTried > 4 + depth * depth * 3) { unmakeMove(m); continue; }
      }

      const ext = givesCheck && ply < depth * 2 + 8 ? 1 : 0;
      const nd = depth - 1 + ext;
      hp++;
      let v;
      if (legal === 1) {
        v = -search(nd, -beta, -alpha, ply + 1, pvNode, true);
      } else {
        let red = 0;
        if (depth >= 3 && quiet && !givesCheck && !chk) {
          red = LMR[Math.min(depth, 63) * 64 + Math.min(legal, 63)];
          if (!pvNode) red++;
          if (m === KILLER1[ply] || m === KILLER2[ply]) red--;
          if (red < 0) red = 0;
          if (red > nd - 1) red = nd - 1 > 0 ? nd - 1 : 0;
        }
        v = -search(nd - red, -alpha - 1, -alpha, ply + 1, false, true);
        if (v > alpha && red) v = -search(nd, -alpha - 1, -alpha, ply + 1, false, true);
        if (v > alpha && v < beta && pvNode) v = -search(nd, -beta, -alpha, ply + 1, true, true);
      }
      hp--;
      unmakeMove(m);
      if (stopped) return 0;

      if (v > best) {
        best = v;
        bestMove = m;
        if (v > alpha) {
          alpha = v;
          if (v >= beta) {
            if (quiet) {
              if (KILLER1[ply] !== m) { KILLER2[ply] = KILLER1[ply]; KILLER1[ply] = m; }
              const bonus = depth * depth;
              const hi = (us * 16 + pieceTypeOf(m)) * NSQ + (m & 255);
              HISTORY[hi] += bonus;
              // 先に試して失敗した静かな手は減点
              const nq = Math.min(quietsTried, 64);
              for (let j = 0; j < nq; j++) {
                const q = QUIETS[qbase + j];
                if (q !== m) HISTORY[(us * 16 + pieceTypeOf(q)) * NSQ + (q & 255)] -= bonus;
              }
              if (HISTORY[hi] > 1000000) for (let j = 0; j < HISTORY.length; j++) HISTORY[j] >>= 1;
            }
            break;
          }
        }
      }
    }

    if (legal === 0) return -MATE + ply; // 指す手がない = 負け

    // 置換表に保存(深さが浅い古い情報は上書き)
    if (ttKey[ti] !== keyHi || depth >= ttDepth[ti] - 2 || ttFlag[ti] === 0) {
      ttKey[ti] = keyHi;
      ttMove[ti] = bestMove;
      ttScore[ti] = scoreToTT(best, ply);
      ttDepth[ti] = depth;
      ttFlag[ti] = best >= beta ? LOWER : best > origAlpha ? EXACT : UPPER;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // USI との変換・ルートの探索
  // ---------------------------------------------------------------------------
  const sqToUsi = (s) => `${9 - COL[s]}${String.fromCharCode(97 + ROW[s])}`;
  function moveToUsi(m) {
    const dt = mDrop(m);
    if (dt) return `${PIECE_CHARS[dt]}*${sqToUsi(m & 255)}`;
    return `${sqToUsi(mFrom(m))}${sqToUsi(m & 255)}${m & 0x100000 ? '+' : ''}`;
  }
  function usiToMove(u) {
    const sq = (f, r) => SQ81[(r.charCodeAt(0) - 97) * 9 + (9 - Number(f))];
    if (u[1] === '*') return sq(u[2], u[3]) | (PIECE_CHARS.indexOf(u[0]) << 16);
    return sq(u[2], u[3]) | (sq(u[0], u[1]) << 8) | (u[4] === '+' ? 0x100000 : 0);
  }

  /** 開始局面と指し手の列から局面と千日手の履歴を作る */
  function setPosition(startSfen, history) {
    setSfen(startSfen);
    hp = 0;
    HIST_LO[0] = keyLo; HIST_HI[0] = keyHi; HIST_CHK[0] = inCheck() ? 1 : 0;
    for (const u of history) {
      makeMove(usiToMove(u));
      sp = 0; // 対局の手は戻さないので undo スタックは使い回す
      hp++;
      HIST_LO[hp] = keyLo; HIST_HI[hp] = keyHi; HIST_CHK[hp] = inCheck() ? 1 : 0;
    }
  }

  /** 合法手の一覧(打ち歩詰めを除く) */
  function legalMoves() {
    const out = [];
    const n = genMoves(SCRATCH, 0, false);
    const buf = SCRATCH.slice(0, n);
    const us = side;
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      makeMove(m);
      const ok = !isAttacked(kingSq[us], us ^ 1) && !(inCheck() && isPawnDropMate(m));
      unmakeMove(m);
      if (ok) out.push(m);
    }
    return out;
  }

  function getSfen() {
    const rows = [];
    for (let r = 0; r < 9; r++) {
      let row = '', empty = 0;
      for (let c = 0; c < 9; c++) {
        const pc = board[SQ81[r * 9 + c]];
        if (!pc) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        const t = pc & 15;
        const ch = PIECE_CHARS[t > 8 ? t - 8 : t];
        row += (t > 8 ? '+' : '') + (pc & WHITE ? ch.toLowerCase() : ch);
      }
      if (empty) row += empty;
      rows.push(row);
    }
    let h = '';
    for (const c of [0, 1]) {
      for (const t of HAND_ORDER) {
        const n = hands[c * 8 + t];
        if (n) h += (n > 1 ? n : '') + (c ? PIECE_CHARS[t].toLowerCase() : PIECE_CHARS[t]);
      }
    }
    return `${rows.join('/')} ${side ? 'w' : 'b'} ${h || '-'} 1`;
  }

  /** 静止探索の値(学習データの選別用) */
  function qsearchValue() {
    stopped = false;
    hardDeadline = Infinity;
    return qsearch(-INF, INF, 0, 0);
  }

  let lastInfo = null;

  /**
   * 今の局面で最善手を探す。
   * allowed: 指してよい USI の集合(null なら制限なし)。budgetMs: 使ってよい時間。maxDepth: 深さの上限
   */
  function think(budgetMs, { allowed = null, maxDepth = 64, softRatio = 0.5 } = {}) {
    const start = now();
    hardDeadline = start + budgetMs;
    const softDeadline = start + budgetMs * softRatio;
    stopped = false;
    nodes = 0;
    KILLER1.fill(0);
    KILLER2.fill(0);
    for (let j = 0; j < HISTORY.length; j++) HISTORY[j] >>= 2;

    let root = legalMoves();
    if (allowed) root = root.filter((m) => allowed.has(moveToUsi(m)));
    if (!root.length) return { move: null, score: -MATE, depth: 0, nodes: 0 };
    if (root.length === 1) return { move: root[0], score: 0, depth: 0, nodes: 0 };

    const rootScores = new Int32Array(root.length);
    let bestMove = root[0], bestScore = -INF, completedDepth = 0;
    const us = side;
    const ti = keyLo & TT_MASK;
    if (ttKey[ti] === keyHi && ttFlag[ti]) {
      const k = root.indexOf(ttMove[ti]);
      if (k > 0) { root.splice(k, 1); root.unshift(ttMove[ti]); }
    }

    let prevScore = 0;
    for (let depth = 1; depth <= maxDepth; depth++) {
      let delta = depth >= 4 ? 60 : INF;
      let alpha = depth >= 4 ? Math.max(-INF, prevScore - delta) : -INF;
      let beta = depth >= 4 ? Math.min(INF, prevScore + delta) : INF;
      let iterBest = 0, iterScore = -INF;
      for (;;) {
        let a = alpha;
        iterBest = 0;
        iterScore = -INF;
        for (let i = 0; i < root.length; i++) {
          const m = root[i];
          makeMove(m);
          hp++;
          const givesCheck = inCheck();
          const nd = depth - 1 + (givesCheck ? 1 : 0);
          let v;
          if (i === 0) v = -search(nd, -beta, -a, 1, true, true);
          else {
            v = -search(nd, -a - 1, -a, 1, false, true);
            if (v > a && v < beta && !stopped) v = -search(nd, -beta, -a, 1, true, true);
          }
          hp--;
          unmakeMove(m);
          if (stopped) break;
          rootScores[i] = v;
          if (v > iterScore) {
            iterScore = v;
            iterBest = m;
          }
          if (v > a) a = v;
          if (v >= beta) break;
        }
        if (stopped) break;
        // アスピレーションの窓から外れたら広げて読み直す
        if (iterScore <= alpha && alpha > -INF) { delta *= 4; alpha = Math.max(-INF, iterScore - delta); continue; }
        if (iterScore >= beta && beta < INF) { delta *= 4; beta = Math.min(INF, iterScore + delta); continue; }
        break;
      }
      if (stopped) {
        // 途中まででも、最善手より良い手が見つかっていれば採用
        if (iterBest && iterScore > bestScore && completedDepth > 0 && iterBest !== bestMove) {
          bestMove = iterBest;
          bestScore = iterScore;
        }
        break;
      }
      bestMove = iterBest;
      bestScore = iterScore;
      prevScore = iterScore;
      completedDepth = depth;
      // 次の深さは良かった手から
      const order = root.map((m, i) => [m === bestMove ? INF + 1 : rootScores[i], m]).sort((x, y) => y[0] - x[0]);
      root = order.map((x) => x[1]);
      if (Math.abs(bestScore) >= MATE_BOUND) break;
      if (now() >= softDeadline) break;
    }
    lastInfo = { score: bestScore, depth: completedDepth, nodes, ms: now() - start };
    return { move: bestMove, ...lastInfo };
  }

  // ---------------------------------------------------------------------------
  // ボットとして登録
  // ---------------------------------------------------------------------------
  const engine = {
    setSfen, setPosition, legalMoves, moveToUsi, usiToMove, think, evaluate, makeMove, unmakeMove,
    genMoves, inCheck, isAttacked, EV, N_PARAMS, OFF_A, OFF_D, OFF_K, REL, BOARD_V, HAND_V,
    extractFeatures, loadParams, getSfen, qsearchValue, initEval,
    get side() { return side; }, get board() { return board; }, get hands() { return hands; },
    get kingSq() { return kingSq; }, get mat() { return mat; },
    setGenAll(v) { GEN_ALL = v; }, setClock(fn) { now = fn; },
    fullKey() { const lo = keyLo, hi = keyHi; fullKey(); const ok = lo === keyLo && hi === keyHi; return ok; },
    fullMaterialCheck() { const m = mat; fullMaterial(); return m === mat; },
    SQ81, ROW, COL, lastInfo: () => lastInfo,
  };

  const bot = {
    name: 'Claude 本気',
    author: 'Claude (Anthropic)',
    description: '一から書いた自作エンジン。PVS+置換表+null move+LMR+静止探索、自作の評価関数(自己対局で調整)',
    move(state) {
      const received = now();
      setPosition(state.startSfen, state.history);
      const allowed = new Set(state.legalMoves);
      const deadline = Math.min(state.deadline || received + state.timeLimitMs, received + state.timeLimitMs);
      const budget = Math.max(50, Math.min(state.timeLimitMs * 0.85, deadline - received) - 40);
      const res = think(budget, { allowed });
      const usi = res.move ? moveToUsi(res.move) : null;
      return usi && allowed.has(usi) ? usi : state.legalMoves[0];
    },
  };

  if (typeof registerBot === 'function') registerBot(bot);
  if (typeof module === 'object' && module && module.exports) {
    module.exports.bot = bot;
    module.exports.engine = engine;
  }
})();
