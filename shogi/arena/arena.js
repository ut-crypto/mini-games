'use strict';

/*
 * AI 対戦場
 *   参加者 = 内蔵 CPU(簡単〜極)+ リポジトリの bots/ フォルダのボット + ページにドロップしたボット
 *   ボットは bot-worker.js(Web Worker)の中で隔離して動かす。仕様は BOT_SPEC.md
 */
const { Game, BLACK, WHITE, HAND_TYPES, PIECE_CHAR, PROMOTED_CHAR, ZEN_DIGIT, KAN_DIGIT } = ShogiCore;
const { LEVELS, CpuPlayer, MEM } = ShogiEngine;

const $ = (sel) => document.querySelector(sel);
const GRACE_MS = 500;        // 持ち時間に上乗せする猶予(通信などのため)
const LOAD_TIMEOUT_MS = 5000;
const LOCAL_KEY = 'shogi-arena-local-bots';
const COLOR_MARK = ['▲', '△'];

const settings = { timeMs: 1000, games: 2, delay: 300 };
const participants = [];
let nextId = 1;
let running = false;
let stopRequested = false;
const stats = new Map(); // id → { win, lose, draw }
const gameLog = [];

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ボット(Web Worker) ----------

class BotSeat {
  constructor(p) {
    this.p = p;
    this.worker = null;
    this.waiter = null;
  }

  /** 1回分の応答を待つ。timeoutMs を過ぎたら { timeout: true } */
  call(msg, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve({ timeout: true });
      }, timeoutMs);
      this.waiter = (data) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(data);
      };
      this.worker.postMessage(msg);
    });
  }

  async start({ color, opponent, timeLimitMs }) {
    this.worker = new Worker('bot-worker.js');
    this.worker.onmessage = (e) => { if (this.waiter) this.waiter(e.data); };
    this.worker.onerror = (e) => {
      e.preventDefault();
      if (this.waiter) this.waiter({ type: 'error', message: e.message || 'ボット内でエラーが起きました' });
    };
    const loaded = await this.call({ type: 'load', code: this.p.code }, LOAD_TIMEOUT_MS);
    if (loaded.type !== 'loaded') throw new Error(loaded.timeout ? '読み込みが時間内に終わりませんでした' : loaded.message);
    const ready = await this.call({ type: 'init', color, opponent, timeLimitMs }, LOAD_TIMEOUT_MS);
    if (ready.type !== 'ready') throw new Error(ready.timeout ? 'init() が時間内に終わりませんでした' : ready.message);
  }

  async think(game, timeLimitMs, opponent) {
    const r = await this.call({
      type: 'move',
      startSfen: game.initialSfen,
      history: game.usiMoves(),
      timeLimitMs,
      opponent,
    }, timeLimitMs + GRACE_MS);
    if (r.timeout) {
      this.dispose(); // 止まらないボットは強制終了
      return { fail: 'timeout' };
    }
    if (r.type === 'error') return { fail: 'error', message: r.message };
    return { move: r.move };
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

/** ボットのコードを読み込んで名前などを調べる(1手指せるかも確認) */
async function inspectBot(code) {
  const seat = new BotSeat({ code });
  try {
    const worker = new Worker('bot-worker.js');
    seat.worker = worker;
    worker.onmessage = (e) => { if (seat.waiter) seat.waiter(e.data); };
    worker.onerror = (e) => {
      e.preventDefault();
      if (seat.waiter) seat.waiter({ type: 'error', message: e.message || 'エラー' });
    };
    const loaded = await seat.call({ type: 'load', code }, LOAD_TIMEOUT_MS);
    if (loaded.type !== 'loaded') throw new Error(loaded.timeout ? '読み込みが時間内に終わりませんでした' : loaded.message);
    const ready = await seat.call({ type: 'init', color: 'black', opponent: 'テスト', timeLimitMs: 2000 }, LOAD_TIMEOUT_MS);
    if (ready.type !== 'ready') throw new Error(ready.timeout ? 'init() が時間内に終わりませんでした' : ready.message);
    const test = await seat.think(new Game(), 2000, 'テスト');
    if (test.fail) throw new Error(test.fail === 'timeout' ? '初手のテストで時間切れ(2秒)' : `初手のテストでエラー: ${test.message}`);
    if (!new Game().pos.findMove(test.move)) throw new Error(`初手のテストで反則手を返しました: ${test.move}`);
    return loaded.meta;
  } finally {
    seat.dispose();
  }
}

// ---------- 内蔵 CPU ----------

class CpuSeat {
  constructor(p, seatIndex) {
    this.p = p;
    const halfkp = LEVELS[p.level].engine === 'halfkp';
    this.cpu = new CpuPlayer(p.level, {
      instanceKey: `arena${seatIndex}`, // 内蔵 CPU 同士でも別々のエンジンで考える
      noPonder: true,                    // 相手の手番中には考えない(ボットと条件を揃える)
      threads: halfkp ? MEM.threads(1) : null,
      hashMB: halfkp ? (MEM.low ? 32 : 128) : null,
    });
  }

  async start({ timeLimitMs }) {
    this.cpu.maxTimeMs = timeLimitMs;
    await this.cpu.init((loaded, total) => {
      if (total) setArenaStatus(`${this.p.name} のエンジンを読み込み中… ${Math.round((loaded / total) * 100)}%`);
    });
  }

  async think(game) {
    const r = await this.cpu.think(game);
    return { move: r.move };
  }

  dispose() {
    this.cpu.abort();
  }
}

// ---------- 参加者 ----------

function addParticipant(p) {
  const entry = { id: nextId++, selected: false, status: 'loading', error: '', ...p };
  participants.push(entry);
  renderParticipants();
  return entry;
}

async function loadBotEntry(entry) {
  entry.status = 'loading';
  renderParticipants();
  try {
    const meta = await inspectBot(entry.code);
    Object.assign(entry, { name: meta.name, author: meta.author, description: meta.description, status: 'ok', error: '' });
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message || String(err);
  }
  renderParticipants();
}

function addBuiltins() {
  for (const [key, lv] of Object.entries(LEVELS)) {
    addParticipant({
      kind: 'cpu',
      level: key,
      name: `CPU ${lv.label}`,
      author: lv.engine === 'halfkp' ? 'やねうら王 + 水匠5' : 'やねうら王 + SuishoPetite',
      description: lv.note,
      status: window.crossOriginIsolated ? 'ok' : 'error',
      error: window.crossOriginIsolated ? '' : 'このブラウザでは使えません(SharedArrayBuffer が無効)',
    });
  }
}

/** リポジトリの bots/ フォルダの一覧(GitHub API → 一覧ファイル index.json の順に試す) */
async function listRepoBots() {
  const found = new Map();
  const gh = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (gh && repo) {
    try {
      const res = await fetch(`https://api.github.com/repos/${gh[1]}/${repo}/contents/shogi/arena/bots`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        for (const f of await res.json()) {
          if (f.type === 'file' && f.name.endsWith('.js')) found.set(f.name, [`bots/${f.name}`, f.download_url]);
        }
      }
    } catch { /* 一覧ファイルにフォールバック */ }
  }
  if (!found.size) {
    try {
      const res = await fetch('bots/index.json', { cache: 'no-cache' });
      if (res.ok) for (const name of (await res.json()).bots || []) found.set(name, [`bots/${name}`]);
    } catch { /* なし */ }
  }
  return found;
}

async function fetchText(urls) {
  for (const u of urls) {
    try {
      const res = await fetch(u, { cache: 'no-cache' });
      if (res.ok) return await res.text();
    } catch { /* 次の URL を試す */ }
  }
  throw new Error('ファイルを読み込めませんでした');
}

async function loadRepoBots() {
  setRepoStatus('リポジトリのボットを探しています…');
  const files = await listRepoBots();
  if (!files.size) {
    setRepoStatus('リポジトリのボットが見つかりませんでした');
    return;
  }
  setRepoStatus(`リポジトリのボット ${files.size}個`);
  await Promise.all([...files].map(async ([file, urls]) => {
    const entry = addParticipant({ kind: 'repo', file, name: file, author: '', code: '' });
    try {
      entry.code = await fetchText(urls);
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
      renderParticipants();
      return;
    }
    await loadBotEntry(entry);
  }));
}

// ドロップしたボット(このブラウザに保存)
function loadSavedLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
}
function saveLocal() {
  const list = participants.filter((p) => p.kind === 'local').map((p) => ({ file: p.file, code: p.code }));
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch { /* 保存できなくても今回は使える */ }
}

async function addLocalFiles(fileList) {
  const jobs = [];
  for (const f of fileList) {
    if (!/\.(m?js|txt)$/i.test(f.name)) {
      setRepoStatus(`${f.name}: .js ファイルを選んでください`, true);
      continue;
    }
    if (f.size > 2 * 1024 * 1024) {
      setRepoStatus(`${f.name}: 2MB を超えるファイルは読み込めません`, true);
      continue;
    }
    const code = await f.text();
    const entry = addParticipant({ kind: 'local', file: f.name, name: f.name, author: '', code, selected: true });
    jobs.push(loadBotEntry(entry));
  }
  saveLocal();
  await Promise.all(jobs);
}

// ---------- 対局 ----------

function makeSeat(p, index) {
  return p.kind === 'cpu' ? new CpuSeat(p, index) : new BotSeat(p);
}

function statsOf(id) {
  if (!stats.has(id)) stats.set(id, { win: 0, lose: 0, draw: 0 });
  return stats.get(id);
}

async function playGame(black, white, no) {
  const game = new Game();
  const players = [black, white];
  const seats = [makeSeat(black, 0), makeSeat(white, 1)];
  let detail = '';
  liveGame = { game, players, thinking: null, no };
  renderLive();

  for (let c = 0; c < 2; c++) {
    try {
      await seats[c].start({ color: c === BLACK ? 'black' : 'white', opponent: players[1 - c].name, timeLimitMs: settings.timeMs });
    } catch (err) {
      game.result = { winner: 1 - c, reason: 'error' };
      detail = `${players[c].name}: ${err.message}`;
      break;
    }
  }

  while (!game.result && !stopRequested) {
    const side = game.pos.side;
    liveGame.thinking = side;
    liveGame.startedAt = performance.now();
    renderLive();
    const r = await seats[side].think(game, settings.timeMs, players[1 - side].name);
    if (stopRequested) break;
    if (r.fail) {
      game.result = { winner: 1 - side, reason: r.fail };
      detail = r.fail === 'timeout' ? `${players[side].name} が持ち時間を超過` : `${players[side].name}: ${r.message}`;
      break;
    }
    if (r.move === 'resign') {
      game.resign(side);
      break;
    }
    if (!game.playUsi(r.move)) {
      game.result = { winner: 1 - side, reason: 'illegal' };
      detail = `${players[side].name} の反則手: ${r.move}`;
      break;
    }
    liveGame.lastMove = game.moves[game.ply - 1].to;
    liveGame.thinking = null;
    renderLive();
    if (settings.delay) await sleep(settings.delay);
  }
  seats.forEach((s) => s.dispose());
  liveGame.thinking = null;
  renderLive();
  if (stopRequested) return null;

  const { winner } = game.result;
  if (winner === null) {
    statsOf(black.id).draw++;
    statsOf(white.id).draw++;
  } else {
    statsOf(players[winner].id).win++;
    statsOf(players[1 - winner].id).lose++;
  }
  gameLog.unshift({ no, black, white, result: game.result, ply: game.ply, detail, kif: kifText(game, black.name, white.name) });
  renderStandings();
  renderLog();
  return game.result;
}

async function runTournament() {
  if (running) return;
  const sel = participants.filter((p) => p.selected && p.status === 'ok');
  if (sel.length < 2) {
    setArenaStatus('読み込みに成功したボットを2つ以上選んでください', true);
    return;
  }
  running = true;
  stopRequested = false;
  stats.clear();
  gameLog.length = 0;
  sel.forEach((p) => statsOf(p.id));
  renderStandings();
  renderLog();
  syncButtons();

  const schedule = [];
  for (let i = 0; i < sel.length; i++) {
    for (let j = i + 1; j < sel.length; j++) {
      for (let g = 0; g < settings.games; g++) schedule.push(g % 2 === 0 ? [sel[i], sel[j]] : [sel[j], sel[i]]);
    }
  }
  standingsIds = sel.map((p) => p.id);
  for (let k = 0; k < schedule.length && !stopRequested; k++) {
    setArenaStatus(`第${k + 1}局 / 全${schedule.length}局`);
    await playGame(schedule[k][0], schedule[k][1], k + 1);
  }
  setArenaStatus(stopRequested ? '中止しました(途中の対局は記録しません)' : `全${schedule.length}局が終わりました`);
  running = false;
  syncButtons();
}

// ---------- 棋譜 ----------

const END_TEXT = {
  checkmate: '詰み', resign: '投了', sennichite: '千日手', 'perpetual-check': '連続王手の千日手',
  'max-moves': `${ShogiCore.MAX_MOVES}手到達`, timeout: '時間切れ', illegal: '反則', error: 'エラー',
};

function kifText(game, blackName, whiteName) {
  const lines = ['# KIF形式棋譜(AI 対戦場)', '手合割：平手', `先手：${blackName}`, `後手：${whiteName}`, '手数----指手---------消費時間--'];
  game.kifs.forEach((k, i) => lines.push(`${String(i + 1).padStart(4)} ${k.slice(1)}`));
  const r = game.result;
  if (r) {
    const end = { resign: '投了', sennichite: '千日手', 'perpetual-check': '反則負け', checkmate: '詰み', 'max-moves': '持将棋', timeout: '切れ負け', illegal: '反則負け', error: '中断' }[r.reason];
    if (end) lines.push(`${String(game.ply + 1).padStart(4)} ${end}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------- 描画 ----------

let liveGame = null;
let standingsIds = [];
const cells = [];

function buildBoard() {
  const board = $('#board');
  for (let i = 0; i < 81; i++) {
    const c = el('div', 'cell');
    board.appendChild(c);
    cells.push(c);
  }
  $('#files').replaceChildren(...Array.from({ length: 9 }, (_, i) => el('span', '', ZEN_DIGIT[9 - i])));
  $('#ranks').replaceChildren(...Array.from({ length: 9 }, (_, i) => el('span', '', KAN_DIGIT[i + 1])));
}

function pieceFace(pc) {
  const char = pc.p ? PROMOTED_CHAR[pc.t] : pc.t === 'K' ? (pc.c === BLACK ? '玉' : '王') : PIECE_CHAR[pc.t];
  const cls = ['piece-face', pc.c === BLACK ? 'black' : 'white', pc.c === WHITE ? 'flip' : '', pc.p ? 'promoted' : '', pc.t === 'K' ? 'king' : '']
    .filter(Boolean).join(' ');
  return el('span', cls, char);
}

function renderHand(target, color, name) {
  target.replaceChildren(el('span', 'hand-label', `${COLOR_MARK[color]} ${name || ''}`));
  const pos = liveGame && liveGame.game.pos;
  if (!pos) return;
  let any = false;
  for (const t of HAND_TYPES) {
    const n = pos.hands[color][t];
    if (!n) continue;
    any = true;
    const b = el('span', 'hand-piece');
    b.appendChild(pieceFace({ c: color, t, p: false }));
    if (n > 1) b.appendChild(el('span', 'count', String(n)));
    target.appendChild(b);
  }
  if (!any) target.appendChild(el('span', 'hand-empty', 'なし'));
}

function renderLive() {
  const g = liveGame && liveGame.game;
  const names = liveGame ? liveGame.players.map((p) => p.name) : ['—', '—'];
  const nb = $('#name-black');
  const nw = $('#name-white');
  nb.textContent = `▲ ${names[0]}`;
  nw.textContent = `△ ${names[1]}`;
  nb.classList.toggle('thinking', !!liveGame && liveGame.thinking === BLACK);
  nw.classList.toggle('thinking', !!liveGame && liveGame.thinking === WHITE);

  let status = '対局待ち';
  if (g) {
    if (g.result) {
      const w = g.result.winner;
      status = `${g.ply}手 ${END_TEXT[g.result.reason] || g.result.reason} → ${w === null ? '引き分け' : `${COLOR_MARK[w]}${names[w]} の勝ち`}`;
    } else {
      status = `第${liveGame.no}局 ${g.ply}手目`;
    }
  }
  $('#live-status').textContent = status;

  renderHand($('#hand-top'), WHITE, names[1]);
  renderHand($('#hand-bottom'), BLACK, names[0]);
  const pos = g ? g.pos : null;
  for (let i = 0; i < 81; i++) {
    const pc = pos ? pos.board[i] : null;
    const cell = cells[i];
    cell.className = `cell${liveGame && liveGame.lastMove === i ? ' last' : ''}`;
    const sig = pc ? `${pc.c}${pc.t}${pc.p}` : '';
    if (cell.dataset.sig !== sig) {
      cell.dataset.sig = sig;
      cell.replaceChildren(...(pc ? [pieceFace(pc)] : []));
    }
  }
  const kifu = $('#kifu');
  if (!g || !g.kifs.length) {
    kifu.replaceChildren(el('li', 'empty', '— 開始局面 —'));
  } else {
    const start = Math.max(0, g.kifs.length - 60);
    kifu.replaceChildren(...g.kifs.slice(start).map((k, i) => {
      const li = el('li', start + i === g.kifs.length - 1 ? 'latest' : '');
      li.append(el('span', 'no', String(start + i + 1)), el('span', '', k));
      return li;
    }));
    kifu.scrollTop = kifu.scrollHeight;
  }
}

function sourceBadge(p) {
  const map = { cpu: ['cpu', '内蔵CPU'], repo: ['repo', 'リポジトリ'], local: ['local', 'ドロップ'] };
  const [cls, text] = map[p.kind];
  return el('span', `badge-src ${cls}`, text);
}

function renderParticipants() {
  const list = $('#participants');
  list.replaceChildren(...participants.map((p) => {
    const li = el('li', `participant${p.selected ? ' selected' : ''}${p.status === 'error' ? ' error' : ''}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = p.selected;
    cb.disabled = p.status !== 'ok' || running;
    cb.setAttribute('aria-label', `${p.name} を参加させる`);
    cb.addEventListener('change', () => { p.selected = cb.checked; renderParticipants(); });

    const body = el('div');
    const title = el('div');
    title.append(el('span', 'p-name', p.name), sourceBadge(p));
    body.appendChild(title);
    const meta = [p.author, p.file && p.kind !== 'cpu' ? p.file : ''].filter(Boolean).join(' / ');
    if (meta) body.appendChild(el('div', 'p-meta', meta));
    if (p.description) body.appendChild(el('div', 'p-desc', p.description));
    if (p.error) body.appendChild(el('div', 'p-err', p.error));

    const side = el('div', 'p-side');
    const stateText = { loading: '確認中…', ok: 'OK', error: 'エラー' }[p.status];
    side.appendChild(el('span', `p-state ${p.status === 'ok' ? 'ok' : p.status === 'error' ? 'ng' : ''}`, stateText));
    if (p.kind === 'local') {
      const rm = el('button', 'ghost p-remove', '削除');
      rm.disabled = running;
      rm.addEventListener('click', () => {
        participants.splice(participants.indexOf(p), 1);
        saveLocal();
        renderParticipants();
      });
      side.appendChild(rm);
    }
    li.append(cb, body, side);
    return li;
  }));
}

function renderStandings() {
  const body = $('#standings');
  const rows = standingsIds
    .map((id) => ({ p: participants.find((x) => x.id === id), s: statsOf(id) }))
    .filter((r) => r.p)
    .map((r) => ({ ...r, points: r.s.win + r.s.draw * 0.5, games: r.s.win + r.s.lose + r.s.draw }))
    .sort((a, b) => b.points - a.points || b.s.win - a.s.win);
  if (!rows.length) {
    body.replaceChildren(Object.assign(el('tr'), { innerHTML: '<td class="empty" colspan="7">まだ対局がありません</td>' }));
    return;
  }
  body.replaceChildren(...rows.map((r, i) => {
    const tr = el('tr', i === 0 && r.games ? 'top' : '');
    const rate = r.games ? `${Math.round((r.points / r.games) * 100)}%` : '—';
    [String(i + 1), r.p.name, r.s.win, r.s.lose, r.s.draw, r.points, rate].forEach((v) => tr.appendChild(el('td', '', String(v))));
    return tr;
  }));
}

function renderLog() {
  const list = $('#game-log');
  if (!gameLog.length) {
    list.replaceChildren(el('li', 'empty', 'まだ対局がありません'));
    return;
  }
  list.replaceChildren(...gameLog.map((g) => {
    const li = el('li');
    const text = el('span', 'g-text');
    const w = g.result.winner;
    text.append(el('span', 'black', `▲${g.black.name}`), ' vs ', el('span', 'white', `△${g.white.name}`), ' → ',
      w === null ? '引き分け' : `${w === BLACK ? g.black.name : g.white.name} の勝ち`, ' ',
      el('span', 'g-reason', `(${g.ply}手 ${END_TEXT[g.result.reason] || g.result.reason}${g.detail ? `: ${g.detail}` : ''})`));
    const copy = el('button', 'ghost', '棋譜');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(g.kif);
        setArenaStatus(`第${g.no}局の棋譜をコピーしました`);
      } catch {
        setArenaStatus('コピーできませんでした', true);
      }
    });
    li.append(el('span', 'g-no', `#${g.no}`), text, copy);
    return li;
  }));
}

function setArenaStatus(text, isError = false) {
  const s = $('#arena-status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function setRepoStatus(text, isError = false) {
  const s = $('#repo-status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function syncButtons() {
  $('#btn-start').disabled = running;
  $('#btn-stop').classList.toggle('hidden', !running);
  renderParticipants();
}

// ---------- 初期化 ----------

function bindSeg(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || running) return;
    settings[key] = Number(b.dataset.v);
    document.querySelectorAll(`${id} button`).forEach((x) => x.classList.toggle('on', x === b));
  });
}

async function loadSpec() {
  try {
    const res = await fetch('BOT_SPEC.md', { cache: 'no-cache' });
    $('#spec-text').textContent = res.ok ? await res.text() : '仕様書を読み込めませんでした';
  } catch {
    $('#spec-text').textContent = '仕様書を読み込めませんでした';
  }
}

function init() {
  buildBoard();
  renderLive();
  renderStandings();
  renderLog();
  bindSeg('#time-seg', 'timeMs');
  bindSeg('#games-seg', 'games');
  bindSeg('#speed-seg', 'delay');

  $('#btn-start').addEventListener('click', runTournament);
  $('#btn-stop').addEventListener('click', () => {
    stopRequested = true;
    setArenaStatus('中止しています…');
  });

  const dz = $('#dropzone');
  const input = $('#file-input');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { addLocalFiles([...input.files]); input.value = ''; });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    addLocalFiles([...e.dataTransfer.files]);
  });

  $('#btn-copy-spec').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#spec-text').textContent);
      setRepoStatus('仕様書をコピーしました。AI に貼り付けてボットを頼んでください');
    } catch {
      setRepoStatus('コピーできませんでした', true);
    }
  });

  if (!window.crossOriginIsolated) {
    setArenaStatus('このブラウザでは内蔵 CPU を使えません(ボット同士の対局はできます)', true);
  }
  addBuiltins();
  for (const saved of loadSavedLocal()) {
    loadBotEntry(addParticipant({ kind: 'local', file: saved.file, name: saved.file, author: '', code: saved.code }));
  }
  loadRepoBots();
  loadSpec();
}

init();
