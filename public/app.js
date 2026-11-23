'use strict';
/* Backroom Hold'em web app: login, lobby, table, account and admin. Talks to server.js. */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const money = c => (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: Math.round(c) % 100 ? 2 : 0, maximumFractionDigits: 2 });
const signed = c => (c > 0 ? '+' : c < 0 ? '−' : '') + money(Math.abs(c));
const RANK_CH = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_CH = ['♠', '♥', '♦', '♣'];
const rankOf = c => (c % 13) + 2, suitOf = c => Math.floor(c / 13);
const COLORS = ['#f2b631', '#7cc3a6', '#e38a6a', '#97b2e8', '#d39ad6', '#c7d27a', '#76c1d8', '#eaa0a0', '#b3a4f0'];
const TYPE_NM = { deposit: 'Transfer in', withdraw: 'Withdrawal', buyin: 'Buy-in', cashout: 'Cash-out' };
const BLINDS = [[0.1, 0.2], [0.25, 0.5], [0.5, 1], [1, 2], [2, 5], [5, 10], [10, 20]];

const App = {
  user: null, setup: false, view: 'auth', lobby: null, es: null, esKey: null, online: false,
  tid: null, tv: null, tvAt: 0, tableMsg: '', pending: null, pre: null, preHid: -1, raise: { open: false, amt: 0 },
  sheet: null, admin: { tab: 'overview', data: null, filter: '', ledger: null, timer: 0, last: 0, player: null }
};
const NT = { size: 9, turn: 25, blinds: 1, min: 10, max: 125, anteBB: 0.5, fee: 5, capBB: 3, hours: 12, anon: true, rathole: true, auth: true, nfnd: false };

/* ---------- Server calls ---------- */
async function api(path, body) {
  const opt = body === undefined ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(path, opt); } catch (e) { throw new Error("Can't reach the server. Check your connection."); }
  let data = {};
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (r.status === 401 && !/\/api\/(login|setup|password)$/.test(path)) { logoutLocal(); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function logoutLocal() {
  App.user = null;
  if (App.es) App.es.close();
  App.es = null; App.esKey = null;
  show('auth');
}

/* ---------- Live stream ---------- */
function stream(tid) {
  const key = tid || '';
  if (App.es && App.esKey === key) return;
  if (App.es) App.es.close();
  App.esKey = key;
  const es = new EventSource('/api/stream' + (tid ? '?t=' + encodeURIComponent(tid) : ''));
  App.es = es;
  es.addEventListener('lobby', e => {
    App.lobby = JSON.parse(e.data);
    App.user = Object.assign(App.user || {}, App.lobby.me);
    renderBalances();
    if (App.view === 'lobby') renderLobby();
  });
  es.addEventListener('table', e => { const tv = JSON.parse(e.data); if (tv.id === App.tid) onTable(tv); });
  es.addEventListener('admin', () => loadAdminSoon());
  es.addEventListener('note', e => toast(JSON.parse(e.data).msg));
  es.onopen = () => { App.online = true; renderBadge(); };
  es.onerror = () => {
    App.online = false; renderBadge();
    clearTimeout(App.chk);
    App.chk = setTimeout(async () => { try { const s = await api('/api/session'); if (!s.user) logoutLocal(); } catch (e) { /* offline; EventSource retries */ } }, 3000);
  };
}

/* ---------- Screens & routing ---------- */
function show(view) {
  App.view = view;
  for (const v of ['auth', 'lobby', 'table', 'admin']) $('#v-' + v).hidden = v !== view;
  closeSheet();
  if (view === 'auth') renderAuth();
  if (view === 'lobby') renderLobby();
  if (view === 'table') requestAnimationFrame(() => { computeLayout(); renderTable(); });
  if (view === 'admin') { renderAdminShell(); loadAdmin(); }
}
function go(hash) { if (location.hash !== '#' + hash) location.hash = hash; else route(); }
function home() { return App.user && App.user.role === 'admin' ? 'admin-' + App.admin.tab : 'lobby'; }
function route() {
  if (!App.user) return show('auth');
  const h = location.hash.slice(1);
  if (h.startsWith('t-')) return openTable(h.slice(2));
  App.tid = null; App.tv = null;
  stream(null);
  if (App.user.role === 'admin') {
    const tab = h.startsWith('admin-') ? h.slice(6) : 'overview';
    App.admin.tab = ['overview', 'players', 'cashier', 'tables', 'fees'].includes(tab) ? tab : 'overview';
    return show('admin');
  }
  show('lobby');
}
window.addEventListener('hashchange', route);

/* ---------- Auth ---------- */
function renderAuth() {
  $('#auth-title').textContent = App.setup ? 'Create the admin account' : 'Log in';
  $('#a-go').textContent = App.setup ? 'Create admin' : 'Log in';
  $('#auth-note').textContent = App.setup
    ? 'This is a new club. The account you create now runs it: players, chips and tables.'
    : 'Accounts are created by the club admin.';
  $('#a-pass').autocomplete = App.setup ? 'new-password' : 'current-password';
}
async function submitAuth() {
  const username = $('#a-user').value.trim(), password = $('#a-pass').value;
  const btn = $('#a-go'); btn.disabled = true;
  try {
    const r = await api(App.setup ? '/api/setup' : '/api/login', { username, password });
    App.user = r.user; App.setup = false; $('#a-pass').value = '';
    go(home());
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

/* ---------- Lobby ---------- */
function timeLeft(t) {
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}
function renderBalances() {
  if (!App.user) return;
  const b = App.user.role === 'player' ? `<span class="chip"></span>${money(App.user.wallet || 0)}` : '';
  setHTML($('#l-bal'), b);
}
function tableCardHTML(t, admin) {
  const c = t.cfg;
  const tags = [];
  if (t.playing) tags.push('<span class="tag2 live">Playing</span>');
  if (t.mine) tags.push('<span class="tag2 me">Seated</span>');
  if (t.pending) tags.push('<span class="tag2 me">Waiting for approval</span>');
  if (t.closing) tags.push('<span class="tag2 warn">Last hand</span>');
  if (c.anon) tags.push('<span class="tag2">Anonymous</span>');
  return `<button class="tcard" data-act="open-table" data-tid="${esc(t.id)}">
    <span class="tl">${esc(t.label)}<small>${c.size}-max</small></span><span class="ts">${t.seated}/${c.size}</span>
    <span class="td">Buy-in ${money(c.min)}–${money(c.max)}${c.ante ? ` · Ante ${money(c.ante)}` : ''} · Fee ${c.fee}%${c.cap ? ` (max ${money(c.cap)})` : ''} · ${c.turn}s to act · ${timeLeft(t.endsAt)}</span>
    ${tags.length ? `<span class="tf">${tags.join('')}</span>` : ''}${admin ? '' : ''}</button>`;
}
function renderLobby() {
  renderBalances();
  const L = App.lobby;
  if (!L) { setHTML($('#l-tables'), '<p class="empty">Loading tables…</p>'); return; }
  setHTML($('#l-tables'), L.tables.length ? L.tables.map(t => tableCardHTML(t)).join('')
    : '<p class="empty">No tables are open right now. The admin opens them.</p>');
}

/* ---------- Table ---------- */
function openTable(tid) {
  if (App.tid !== tid) { App.tv = null; App.tableMsg = ''; App.pending = null; App.pre = null; App.raise.open = false; }
  App.tid = tid;
  stream(tid);
  show('table');
}
function onTable(tv) {
  if (tv.closed) { App.tv = null; App.tableMsg = 'This table is closed.'; renderTable(); return; }
  const prevSize = App.tv ? App.tv.cfg.size : 0;
  App.tv = tv; App.tvAt = Date.now(); App.tableMsg = '';
  if (App.pending && (tv.v > App.pending.v || Date.now() - App.pending.at > 6000)) App.pending = null;
  if (App.preHid !== tv.h.id) { App.pre = null; App.preHid = tv.h.id; }
  if (!tv.me || tv.h.toAct !== tv.me.seat) App.raise.open = false;
  if (prevSize !== tv.cfg.size) computeLayout();
  maybePre();
  if (App.view === 'table') renderTable();
  if (App.sheet === 'tablemenu') renderTableMenu();
}
const live = tv => tv.h.ph !== 'wait' && tv.h.ph !== 'show';
function myTurn(tv) {
  const m = tv.me;
  return !!m && live(tv) && tv.h.toAct === m.seat && !tv.h.run && tv.seats[m.seat].st === '' && !App.pending;
}
function maybePre() {
  const tv = App.tv;
  if (App.pre !== 'cf' || !myTurn(tv)) return;
  App.pre = null;
  act(tv.me.toCall > 0 ? 'f' : 'k');
}
async function act(a, amt) {
  const tv = App.tv;
  App.pending = { v: tv.v, at: Date.now() }; App.raise.open = false;
  renderDock();
  try { await api('/api/table/act', { tid: tv.id, a, amt: amt ? amt / 100 : 0, hid: tv.h.id }); }
  catch (e) { App.pending = null; toast(e.message); renderDock(); }
}

let L = null;
function computeLayout() {
  const ar = $('#arena');
  const w = ar.clientWidth, h = ar.clientHeight;
  if (!w || !h) return;
  const n = App.tv ? App.tv.cfg.size : 9;
  const portrait = h >= w * 0.95;
  let bw, bh;
  if (portrait) { bw = Math.min(w, h * 0.74); bh = Math.min(h, bw * 1.8); } else { bh = h; bw = Math.min(w, h * 1.9); }
  const bx = (w - bw) / 2, by = (h - bh) / 2;
  const cx = bx + bw / 2, cy = by + bh * (portrait ? 0.47 : 0.48);
  const rx = bw * (portrait ? 0.41 : 0.44), ry = bh * (portrait ? 0.42 : 0.39);
  const pos = [];
  for (let v = 0; v < n; v++) {
    const a = Math.PI / 2 + v * 2 * Math.PI / n, co = Math.cos(a), si = Math.sin(a);
    // a squarer ellipse so seats sit on a stadium-shaped rail
    const x = cx + rx * Math.sign(co) * Math.pow(Math.abs(co), 0.75), y = cy + ry * Math.sign(si) * Math.pow(Math.abs(si), 0.85);
    pos.push([clamp(x, 46, w - 46), clamp(y, 34, h - 44)]);
  }
  const fw = rx * 2 * 0.8, fh = ry * 2 * 0.86;
  L = { w, h, portrait, pos, cx, cy, n };
  Object.assign($('#felt').style, { left: (cx - fw / 2) + 'px', top: (cy - fh / 2) + 'px', width: fw + 'px', height: fh + 'px' });
  const c = $('#center'); c.style.left = cx + 'px'; c.style.top = (cy - 6) + 'px';
}
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }
function cardHTML(c, extra) { return `<div class="card s${suitOf(c)} ${extra || ''}"><b>${RANK_CH[rankOf(c)]}</b><i>${SUIT_CH[suitOf(c)]}</i></div>`; }
function colorFor(s) { let x = 0; for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[x % COLORS.length]; }
function initials(n) { const p = String(n).trim().split(/\s+/); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
function ensureSeats(n) {
  const wrap = $('#seats');
  if (wrap.children.length === n) return;
  wrap.innerHTML = ''; $('#bets').innerHTML = ''; $('#board').innerHTML = '';
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'seat vacant'; el.id = 'seat-' + i;
    el.innerHTML = '<div class="slot-ui"></div><div class="hole"></div><div class="av"></div><div class="plate"></div><div class="tags"></div>';
    wrap.appendChild(el);
    const b = document.createElement('div'); b.className = 'bet'; b.id = 'bet-' + i; b.hidden = true; $('#bets').appendChild(b);
  }
  for (let k = 0; k < 5; k++) { const s = document.createElement('div'); s.id = 'b-' + k; $('#board').appendChild(s); }
}
function renderBadge() {
  if (App.view !== 'table') return;
  const tv = App.tv;
  setHTML($('#t-badge'), !App.online ? '<span class="pill off">Reconnecting</span>' : tv && tv.isAdmin ? '<span class="pill watch">Watching</span>' : '');
}
function renderTable() {
  const tv = App.tv;
  const n = tv ? tv.cfg.size : 9;
  ensureSeats(n);
  if (!L || L.n !== n) computeLayout();
  if (!L) return;
  $('#t-label').textContent = tv ? tv.label : 'Table';
  $('#t-meta').textContent = tv ? `${tv.cfg.size}-max · ${timeLeft(tv.endsAt)}` : '';
  renderBadge();
  const mi = tv && tv.me ? tv.me.seat : -1, rot = mi >= 0 ? mi : 0;
  const h = tv ? tv.h : null;
  const best = h && h.ph === 'show' && h.res && h.res[0] && h.res[0].best ? { set: new Set(h.res[0].best), w: new Set(h.res[0].w) } : null;
  const canSit = tv && mi < 0 && !tv.isAdmin && !tv.pending && !tv.closing;
  for (let i = 0; i < n; i++) {
    const el = $('#seat-' + i), bet = $('#bet-' + i);
    const s = tv ? tv.seats[i] : null;
    const v = (i - rot + n) % n, [x, y] = L.pos[v];
    el.style.left = x + 'px'; el.style.top = y + 'px';
    const [slot, hole, av, plate, tags] = el.children;
    if (!s || s.reserved) {
      el.className = 'seat vacant';
      setHTML(slot, s && s.reserved ? `<div class="emptyseat res">${s.mine ? 'Yours' : 'Held'}</div>`
        : canSit ? `<button class="sitbtn" data-act="sit" data-seat="${i}" aria-label="Sit in seat ${i + 1}">Sit</button>` : (tv ? '<div class="emptyseat"></div>' : ''));
      bet.hidden = true;
      continue;
    }
    const won = h.won && h.won[i];
    el.className = 'seat' + (s.me ? ' me' : '') + (h.toAct === i && !h.run && live(tv) ? ' turn' : '') + (s.st === 'f' ? ' fold' : '') +
      (s.st === 'o' && live(tv) ? ' out' : '') + (won ? ' win' : '') + (s.so || s.away ? ' so' : '');
    const hi = c => (best && best.w.has(i) && best.set.has(c) ? 'hi' : '');
    const dc = h.ph === 'show' || s.st === 'f' ? '' : 'deal ';
    let holeHTML = '', cls = 'hole';
    if (s.me && s.cards) { cls = 'hole big'; holeHTML = s.cards.map(c => cardHTML(c, dc + hi(c) + (s.st === 'f' ? ' dim' : ''))).join(''); }
    else if (s.cards) { cls = 'hole faces'; holeHTML = s.cards.map(c => cardHTML(c, dc + hi(c))).join(''); }
    else if (s.inHand) { cls = 'hole backs'; holeHTML = `<div class="card back ${dc}"></div><div class="card back ${dc}"></div>`; }
    hole.className = cls; setHTML(hole, holeHTML);
    av.style.setProperty('--c', colorFor(s.name));
    setHTML(av, esc(initials(s.name)));
    setHTML(plate, `<span class="nm">${esc(s.name)}</span><span class="stk">${s.st === 'a' && !s.stack ? 'All-in' : money(s.stack)}</span>`);
    let tag = '';
    if (won) tag = `<span class="tag win">+${money(won)}</span>`;
    else if (s.so) tag = '<span class="tag away">Sitting out</span>';
    else if (s.away) tag = '<span class="tag away">Away</span>';
    else if (s.last) tag = `<span class="tag ${/^Fold/.test(s.last) ? 'fold' : /^(Raise|Bet|All)/.test(s.last) ? 'raise' : 'call'}">${esc(s.last)}</span>`;
    setHTML(tags, tag);
    if (s.bet > 0) {
      const t = v === 0 ? 0.47 : 0.38;
      bet.hidden = false;
      bet.style.left = (x + (L.cx - x) * t) + 'px'; bet.style.top = (y + (L.cy - y) * t) + 'px';
      setHTML(bet, `<span class="chip"></span>${money(s.bet)}`);
    } else bet.hidden = true;
  }
  const dl = $('#dealer');
  if (tv && h.btn >= 0 && tv.seats[h.btn] && !tv.seats[h.btn].reserved && h.ph !== 'wait') {
    const v = (h.btn - rot + n) % n, [x, y] = L.pos[v], side = x < L.cx ? 1 : -1;
    dl.hidden = false;
    dl.style.left = (v === 0 ? x - 62 : x + (L.cx - x) * 0.27 + side * 30) + 'px';
    dl.style.top = (v === 0 ? y + 14 : y + (L.cy - y) * 0.27) + 'px';
  } else dl.hidden = true;
  for (let k = 0; k < 5; k++) {
    const c = h ? h.board[k] : undefined;
    setHTML($('#b-' + k), c === undefined ? '<div class="slot"></div>' : cardHTML(c, best ? (best.set.has(c) ? 'hi' : '') : 'deal'));
  }
  setHTML($('#pot'), h && h.pot ? `<span class="chip"></span>Pot ${money(h.pot)}` : '');
  setHTML($('#banner'), bannerHTML());
  renderDock();
}
function bannerHTML() {
  const tv = App.tv;
  if (!tv) return esc(App.tableMsg || 'Connecting…');
  const h = tv.h;
  if (h.ph === 'show' && h.res) {
    const lines = h.res.filter(r => r.name || h.res.length === 1).slice(0, 2).map(r => {
      const names = r.w.map(i => (tv.seats[i] && tv.seats[i].name) || 'Player').map(esc).join(' & ');
      return `<b>${names}</b> ${r.w.length > 1 ? 'split' : 'wins'} ${money(r.amt)}${r.name ? `<br><span class="sub">${esc(r.name)}</span>` : ''}`;
    });
    return lines.join('<br>') + (h.rake ? `<br><span class="sub">Fee ${money(h.rake)}</span>` : '');
  }
  if (tv.closing && !live(tv)) return 'The table is closing.';
  if (h.ph === 'wait') {
    const ready = tv.seats.filter(s => s && !s.reserved && !s.so && s.stack > 0).length;
    return ready >= 2 ? 'Next hand is about to start…' : 'Waiting for players';
  }
  if (h.run) return '<span class="sub">All-in. Running the board…</span>';
  if (tv.closing) return '<span class="sub">Last hand before the table closes</span>';
  return '';
}
function renderDock() {
  const dock = $('#dock'), tv = App.tv;
  if (!tv) { setHTML(dock, `<div class="dock-msg">${esc(App.tableMsg || 'Connecting to the table…')}</div>`); return; }
  const h = tv.h, m = tv.me;
  if (tv.isAdmin) { setHTML(dock, `<div class="dock-msg">You're watching as admin. Players' cards stay hidden until showdown.</div>`); return; }
  if (!m) {
    if (tv.pending) {
      setHTML(dock, `<div class="dock-msg">Waiting for the admin to approve your buy-in of <b>${money(tv.pending.amount)}</b>.</div><div class="acts"><button class="act ghost wide" data-act="cancel-req">Cancel request</button></div>`);
      return;
    }
    const lim = tv.limits;
    const msg = tv.closing ? 'This table is closing.'
      : !tv.seats.some(s => !s) ? "The table is full. You're watching."
      : `Tap an open seat to sit down. Buy-in ${money(lim.min)}–${money(lim.max)}. Your balance: ${money(tv.wallet)}.`;
    setHTML(dock, `<div class="dock-msg">${esc(msg)}</div>`);
    return;
  }
  const s = tv.seats[m.seat];
  const info = `<div class="dock-info"><b>${esc(m.hand)}</b><span>${m.net ? `Session <span class="${m.net > 0 ? 'up' : 'down'}">${signed(m.net)}</span>` : ''}</span></div>`;
  let body = '';
  if (myTurn(tv)) {
    const callAmt = Math.min(m.toCall, s.stack);
    if (App.raise.open && m.canRaise) {
      body = `<div class="timer" id="my-timer"><span></span></div><div class="raise">
        <div class="r-top"><button class="step" data-act="r-minus" aria-label="Lower">−</button><output class="r-amt" id="r-amt"></output><button class="step" data-act="r-plus" aria-label="Higher">+</button></div>
        <input id="r-slider" type="range" min="${m.minTo}" max="${m.maxTo}" step="${tv.cfg.sb}" aria-label="Amount">
        <div class="presets">${[['Min', 'min'], ['½ Pot', '0.5'], ['¾ Pot', '0.75'], ['Pot', '1'], ['All-in', 'max']].map(([l, f]) => `<button data-act="preset" data-f="${f}">${l}</button>`).join('')}</div>
        <div class="acts"><button class="act ghost" data-act="r-cancel">Back</button><button class="act raise" data-act="r-go" id="r-go">Raise</button></div></div>`;
    } else {
      body = `<div class="timer" id="my-timer"><span></span></div><div class="acts">
        <button class="act fold" data-act="fold">Fold</button>
        ${m.toCall === 0 ? '<button class="act call" data-act="check">Check</button>'
          : `<button class="act call" data-act="call">${callAmt >= s.stack ? 'All-in' : 'Call'}<small>${money(callAmt)}</small></button>`}
        ${m.canRaise ? `<button class="act raise" data-act="r-open">${h.cur === 0 ? 'Bet' : 'Raise'}</button>` : ''}</div>`;
    }
  } else if (live(tv) && s.st === '' && !h.run) {
    const who = tv.seats[h.toAct];
    body = `<div class="dock-row"><span class="dock-msg">${App.pending ? 'Sending…' : who && !who.reserved ? `Waiting for ${esc(who.name)}` : ''}</span>
      <button class="toggle ${App.pre === 'cf' ? 'on' : ''}" data-act="pre-cf" aria-pressed="${App.pre === 'cf'}">Check / Fold</button></div>`;
  } else if (live(tv) && s.st === 'a') body = `<div class="dock-msg">You're all-in. Good luck.</div>`;
  else if (live(tv) && s.st === 'f') body = `<div class="dock-msg">Waiting for the next hand…</div>`;
  else if (tv.pending) body = `<div class="dock-msg">Waiting for the admin to approve adding <b>${money(tv.pending.amount)}</b>.</div><div class="acts"><button class="act ghost wide" data-act="cancel-req">Cancel request</button></div>`;
  else if (s.stack === 0) body = `<div class="dock-msg">You're out of chips.</div><div class="acts"><button class="act ghost" data-act="leave">Stand up</button><button class="act raise" data-act="add">Add chips</button></div>`;
  else if (s.so) body = `<div class="dock-msg">You're sitting out.</div><div class="acts"><button class="act call wide" data-act="backin">I'm back, deal me in</button></div>`;
  else if (live(tv)) body = `<div class="dock-msg">You'll be dealt in next hand.</div>`;
  else if (h.ph === 'show') body = `<div class="dock-msg">Next hand in a moment…</div>`;
  else body = `<div class="dock-msg">${tv.closing ? 'The table is closing.' : 'Waiting for more players to sit down.'}</div>`;
  setHTML(dock, info + body);
  if (myTurn(tv) && App.raise.open) { App.raise.amt = clamp(App.raise.amt || m.minTo, m.minTo, m.maxTo); syncRaise(); }
}
function setRaise(v) {
  const m = App.tv.me, step = App.tv.cfg.sb;
  App.raise.amt = clamp(Math.round(v / step) * step, m.minTo, m.maxTo);
  syncRaise();
}
function syncRaise() {
  const sl = $('#r-slider');
  if (!sl) return;
  const m = App.tv.me;
  sl.value = App.raise.amt;
  $('#r-amt').textContent = money(App.raise.amt);
  $('#r-go').textContent = App.raise.amt >= m.maxTo ? `All-in ${money(m.maxTo)}` : App.tv.h.cur === 0 ? `Bet ${money(App.raise.amt)}` : `Raise to ${money(App.raise.amt)}`;
}
setInterval(() => {
  if (App.view !== 'table' || !App.tv) return;
  const tv = App.tv, h = tv.h;
  if (h.toAct < 0 || h.run || !live(tv)) return;
  const frac = clamp((h.left - (Date.now() - App.tvAt)) / (tv.cfg.turn * 1000), 0, 1);
  const el = $('#seat-' + h.toAct);
  if (el) { el.querySelector('.av').style.setProperty('--t', frac.toFixed(3)); el.classList.toggle('hurry', frac < 0.25); }
  const tm = $('#my-timer');
  if (tm) { tm.style.setProperty('--t', frac.toFixed(3)); tm.classList.toggle('hurry', frac < 0.25); }
  if (App.pending && Date.now() - App.pending.at > 6000) { App.pending = null; renderDock(); }
}, 200);

/* ---------- Sheets ---------- */
function openSheet(kind, html) { App.sheet = kind; $('#sheet').hidden = false; setHTML($('#sheet'), `<div class="sheet-card" role="dialog"><div class="grab"></div>${html}</div>`); }
function closeSheet() { App.sheet = null; $('#sheet').hidden = true; setHTML($('#sheet'), ''); }

function buyinSheet(kind, seat) {
  const tv = App.tv, lim = tv.limits, cfg = tv.cfg;
  const s = kind === 'add' ? tv.seats[tv.me.seat] : null;
  const lo = kind === 'add' ? Math.min(cfg.bb, lim.max - s.stack) : lim.min;
  const hi = Math.min(kind === 'add' ? lim.max - s.stack : lim.max, tv.wallet);
  App.buy = { kind, seat, lo, hi, amt: clamp(kind === 'add' ? hi : Math.min(lim.max, hi), lo, hi) };
  const short = hi < lo || hi <= 0;
  const rh = lim.rathole && kind === 'sit' ? `<p class="note warn">No rathole: you left this table with ${money(lim.rathole)} less than 2 hours ago, so you need to bring at least that much.</p>` : '';
  openSheet('buyin', `<h3>${kind === 'add' ? 'Add chips' : `Buy in <span>Seat ${seat + 1}</span>`}</h3>
    <p>${esc(tv.label)} · ${kind === 'add' ? `Up to ${money(lim.max)} on the table` : `Buy-in ${money(lim.min)}–${money(lim.max)}`} · Your balance ${money(tv.wallet)}</p>
    ${rh}
    ${short ? `<p class="note warn">Your balance isn't enough. You need at least ${money(lo)}. Ask the admin to transfer you chips.</p><button class="btn" data-act="close-sheet">Close</button>` : `
    <div class="big-amt" id="buy-amt"></div>
    <input type="range" id="buy-slider" min="${lo}" max="${hi}" step="${cfg.sb}" aria-label="Buy-in amount">
    <div class="presets"><button data-act="buy-p" data-f="0">Min</button><button data-act="buy-p" data-f="0.5">Half</button><button data-act="buy-p" data-f="1">Max</button></div>
    ${cfg.auth ? '<p class="note">The admin approves every buy-in at this table. Your seat is held while you wait.</p>' : ''}
    <div class="two"><button class="btn" data-act="close-sheet">Cancel</button><button class="btn gold" data-act="buy-go">${cfg.auth ? 'Request' : kind === 'add' ? 'Add' : 'Sit down'}</button></div>`}`);
  syncBuy();
}
function syncBuy() {
  const sl = $('#buy-slider');
  if (!sl || !App.buy) return;
  sl.value = App.buy.amt;
  $('#buy-amt').textContent = money(App.buy.amt);
}
async function submitBuy() {
  const b = App.buy, tv = App.tv;
  try {
    const r = b.kind === 'add'
      ? await api('/api/table/add', { tid: tv.id, amount: b.amt / 100 })
      : await api('/api/table/sit', { tid: tv.id, seat: b.seat, amount: b.amt / 100 });
    closeSheet();
    if (r.pending) toast('Request sent. The admin will approve it shortly.');
  } catch (e) { toast(e.message); }
}
function renderTableMenu() {
  const tv = App.tv;
  if (!tv) { closeSheet(); return; }
  const m = tv.me, s = m ? tv.seats[m.seat] : null, c = tv.cfg;
  const btns = [];
  if (s) {
    if (m.canAdd && !tv.pending) btns.push('<button class="btn" data-act="add">Add chips</button>');
    btns.push(s.so ? '<button class="btn" data-act="backin">I\'m back</button>' : '<button class="btn" data-act="sitout">Sit out</button>');
    btns.push('<button class="btn danger" data-act="leave">Stand up</button>');
  }
  if (tv.isAdmin) btns.push(`<button class="btn danger" data-act="close-table" data-tid="${esc(tv.id)}">Close table</button>`);
  setHTML($('#sheet'), `<div class="sheet-card" role="dialog"><div class="grab"></div>
    <h3>${esc(tv.label)} <span>${c.size}-max</span></h3>
    ${btns.length ? `<div class="sheet-acts">${btns.join('')}</div>` : ''}
    <h4>Table rules</h4>
    <dl class="rules">
      <dt>Game</dt><dd>No-Limit Hold'em</dd>
      <dt>Blinds</dt><dd>${money(c.sb)}/${money(c.bb)}</dd>
      <dt>Ante</dt><dd>${c.ante ? `${money(c.ante)} (${c.anteBB} BB)` : 'None'}</dd>
      <dt>Buy-in</dt><dd>${money(c.min)}–${money(c.max)}</dd>
      <dt>Fee</dt><dd>${c.fee}% of each pot${c.cap ? `, max ${money(c.cap)}` : ''}${c.nfnd ? ', no flop no fee' : ''}</dd>
      <dt>Time to act</dt><dd>${c.turn}s</dd>
      <dt>Table closes</dt><dd>${new Date(tv.endsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</dd>
      ${c.anon ? '<dt>Anonymous</dt><dd>Names hidden</dd>' : ''}
      ${c.rathole ? '<dt>No rathole</dt><dd>2 hours</dd>' : ''}
      ${c.auth ? '<dt>Buy-ins</dt><dd>Approved by admin</dd>' : ''}
    </dl>
    <h4>Hand history</h4>
    <ol class="log">${tv.log.length ? tv.log.slice().reverse().map(l => `<li>${esc(l)}</li>`).join('') : '<li>Nothing yet.</li>'}</ol>
    <button class="btn" data-act="close-sheet">Close</button></div>`);
}
async function accountSheet() {
  const u = App.user;
  openSheet('account', `<h3>${esc(u.username)} <span>${u.role === 'admin' ? 'Admin' : ''}</span></h3>
    ${u.role === 'player' ? `<p>Balance</p><div class="big-amt">${money(u.wallet || 0)}</div><h4>History</h4><div class="list" id="acct-hist"><p class="empty">Loading…</p></div>` : ''}
    <h4>Change password</h4>
    <form id="pw-form" class="list">
      <input class="txt" type="password" id="pw-cur" placeholder="Current password" autocomplete="current-password" aria-label="Current password">
      <input class="txt" type="password" id="pw-new" placeholder="New password (6+ characters)" autocomplete="new-password" aria-label="New password">
      <button class="btn" type="submit">Change password</button>
    </form>
    <div class="two"><button class="btn danger" data-act="logout">Log out</button><button class="btn" data-act="close-sheet">Close</button></div>`);
  if (u.role === 'player') {
    try {
      const r = await api('/api/my/ledger');
      setHTML($('#acct-hist'), r.items.length ? r.items.map(ledgerRow).join('') : '<p class="empty">No transactions yet.</p>');
    } catch (e) { setHTML($('#acct-hist'), `<p class="empty">${esc(e.message)}</p>`); }
  }
}
function when(t) {
  const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function ledgerRow(e, withUser) {
  return `<div class="ritem"><span class="a"><span class="nm">${withUser ? `${esc(e.username)} · ` : ''}${TYPE_NM[e.type] || esc(e.type)}</span></span>
    <span class="b ${e.amount > 0 ? 'up' : 'down'}">${signed(e.amount)}</span>
    <span class="c">${when(e.t)}${e.note ? ' · ' + esc(e.note) : ''}${e.by ? ' · by ' + esc(e.by) : ''}</span>
    <span class="d">Bal ${money(e.bal)}</span></div>`;
}

/* ---------- Admin ---------- */
function loadAdminSoon() {
  if (!App.user || App.user.role !== 'admin') return;
  const wait = Math.max(0, 1000 - (Date.now() - App.admin.last));
  clearTimeout(App.admin.timer);
  App.admin.timer = setTimeout(loadAdmin, wait);
}
async function loadAdmin() {
  App.admin.last = Date.now();
  try { App.admin.data = await api('/api/admin/overview'); } catch (e) { toast(e.message); return; }
  if (App.view === 'admin') { renderAdminTabs(); fillAdmin(); }
  if (App.sheet === 'player') fillPlayerSheet();
  if (App.admin.tab === 'cashier' && App.view === 'admin') loadLedger();
}
function renderAdminTabs() {
  const d = App.admin.data, req = d ? d.requests.length : 0;
  setHTML($('#a-tabs'), [['overview', 'Overview'], ['players', 'Players'], ['cashier', 'Cashier'], ['tables', 'Tables'], ['fees', 'Fees']].map(([k, l]) =>
    `<button data-act="atab" data-k="${k}" aria-pressed="${App.admin.tab === k}">${l}${k === 'overview' && req ? `<span class="badge">${req}</span>` : ''}</button>`).join(''));
}
function renderAdminShell() {
  renderAdminTabs();
  const t = App.admin.tab;
  const body = {
    overview: `<div id="ov-req" class="list"></div><div class="tiles" id="ov-tiles"></div><h3 class="sect">Open tables</h3><div id="ov-tables" class="list"></div>`,
    players: `<form id="np-form" class="panel"><h2>New player</h2>
        <div class="two"><input class="txt" id="np-user" placeholder="Username" autocapitalize="none" spellcheck="false" autocomplete="off" aria-label="Username">
        <input class="txt" id="np-pass" placeholder="Password" autocomplete="new-password" aria-label="Password"></div>
        <input class="txt" id="np-chips" type="number" inputmode="decimal" min="0" step="any" placeholder="Starting chips (optional)" aria-label="Starting chips">
        <button class="btn gold" type="submit">Create player</button>
        <p class="note">Give the player their username and password. They can change the password after logging in.</p></form>
      <h3 class="sect">Players</h3><div id="pl-list" class="list"></div>`,
    cashier: `<div class="tiles" id="cs-tiles"></div>
      <div class="filters" id="cs-filters"></div><div id="cs-list" class="list"></div>`,
    tables: tableForm() + `<h3 class="sect">Tables</h3><div id="tb-list" class="list"></div>`,
    fees: `<div class="tiles" id="fe-tiles"></div><div class="panel"><h2>Fees, last 14 days</h2><div class="bars" id="fe-chart"></div></div>
      <h3 class="sect">Recent hands</h3><div id="fe-recent" class="list"></div>`
  }[t];
  setHTML($('#a-body'), body);
  if (t === 'cashier') { renderFilters(); loadLedger(); }
  fillAdmin();
}
function fillAdmin() {
  const d = App.admin.data;
  if (!d) return;
  const T = d.totals, t = App.admin.tab;
  if (t === 'overview') {
    setHTML($('#ov-req'), d.requests.length ? `<h3 class="sect">Buy-in requests</h3>` + d.requests.map(r => `<div class="req">
        <div class="rt"><b>${esc(r.username)}</b> wants to ${r.kind === 'sit' ? `buy in for <b>${money(r.amount)}</b> (seat ${r.seat + 1})` : `add <b>${money(r.amount)}</b>`} at ${esc(r.label)}</div>
        <div class="note">Balance ${money(r.wallet)} · ${when(r.t)}</div>
        <div class="two"><button class="btn danger sm" data-act="req" data-rid="${esc(r.id)}" data-ok="0">Decline</button><button class="btn green sm" data-act="req" data-rid="${esc(r.id)}" data-ok="1">Approve</button></div></div>`).join('') : '');
    setHTML($('#ov-tiles'), tile('In player balances', money(T.wallets)) + tile('On tables', money(T.tables)) + tile('Fees today', money(T.today), 'gold') +
      tile('Fees all time', money(T.rake), 'gold') + tile('Chips issued (net)', money(T.issued)) +
      `<div class="tile ${T.balanced ? 'ok' : 'no'}"><span class="k">Books</span><span class="v">${T.balanced ? 'Balanced ✓' : 'Mismatch'}</span><span class="k">Issued = balances + tables + fees</span></div>`);
    const open = d.tables.filter(x => x.status === 'open');
    setHTML($('#ov-tables'), open.length ? open.map(adminTableRow).join('') : '<p class="empty">No open tables. Start one in Tables.</p>');
  }
  if (t === 'players') {
    setHTML($('#pl-list'), d.users.length ? d.users.map(u => `<button class="ritem" data-act="player" data-uid="${esc(u.id)}">
      <span class="a"><span class="dot ${u.online ? 'on' : ''}"></span><span class="nm">${esc(u.username)}</span>${u.disabled ? '<span class="tag2 warn">Disabled</span>' : ''}</span>
      <span class="b">${money(u.wallet)}</span>
      <span class="c">${u.at.length ? 'At ' + esc(u.at.join(', ')) : u.lastLogin ? 'Last login ' + when(u.lastLogin) : 'Never logged in'}</span>
      <span class="d">${u.onTable ? 'On table ' + money(u.onTable) : 'Balance'}</span></button>`).join('') : '<p class="empty">No players yet. Create the first one above.</p>');
  }
  if (t === 'cashier') {
    setHTML($('#cs-tiles'), tile('Transferred in', money(T.deposits)) + tile('Withdrawn', money(T.withdrawals)) + tile('In player balances', money(T.wallets)));
  }
  if (t === 'tables') {
    setHTML($('#tb-list'), d.tables.length ? d.tables.map(adminTableRow).join('') : '<p class="empty">No tables yet.</p>');
  }
  if (t === 'fees') {
    const week = d.rakeDays.slice(-7).reduce((a, x) => a + x.amt, 0);
    setHTML($('#fe-tiles'), tile('Today', money(T.today), 'gold') + tile('Last 7 days', money(week), 'gold') + tile('All time', money(T.rake), 'gold'));
    const max = Math.max(1, ...d.rakeDays.map(x => x.amt));
    setHTML($('#fe-chart'), d.rakeDays.map(x => `<div class="bcol" title="${esc(x.day)}: ${money(x.amt)}">
      ${x.amt ? `<span class="bv">${money(x.amt)}</span>` : ''}<div class="bar ${x.amt ? '' : 'zero'}" style="height:${Math.max(2, x.amt / max * 100)}%"></div><span class="bl">${x.day.slice(8)}</span></div>`).join(''));
    setHTML($('#fe-recent'), d.rakeRecent.length ? d.rakeRecent.map(r => `<div class="ritem"><span class="a"><span class="nm">${esc(r.label)} · hand #${r.hand}</span></span>
      <span class="b up">+${money(r.fee)}</span><span class="c">${when(r.t)}</span><span class="d">Pot ${money(r.pot)}</span></div>`).join('') : '<p class="empty">No fees yet. They appear here after each hand.</p>');
  }
}
const tile = (k, v, cls) => `<div class="tile ${cls || ''}"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
function adminTableRow(t) {
  const c = t.cfg, open = t.status === 'open';
  return `<div class="ritem"><span class="a"><span class="nm">${esc(t.label)} · ${c.size}-max</span>${open ? (t.closing ? '<span class="tag2 warn">Closing</span>' : '<span class="tag2 live">Open</span>') : '<span class="tag2">Closed</span>'}</span>
    <span class="b up">+${money(t.rake)}</span>
    <span class="c">${t.hands} hands · ${open ? `${t.players.length}/${c.size} seated · ${timeLeft(t.endsAt)}` : 'Closed ' + when(t.closedAt)}${t.players.length ? '<br>' + t.players.map(p => `${esc(p.name)} ${money(p.stack)}`).join(' · ') : ''}</span>
    <span class="d">fees</span>
    ${open ? `<span class="row" style="grid-column:1/-1;margin-top:6px"><button class="btn sm" data-act="open-table" data-tid="${esc(t.id)}">Watch</button>${t.closing ? '' : `<button class="btn sm danger" data-act="close-table" data-tid="${esc(t.id)}">Close table</button>`}</span>` : ''}</div>`;
}
function tableForm() {
  const bl = BLINDS[NT.blinds];
  const slider = (k, lab, min, max, step, fmt, help) => `<div class="set"><label for="nt-${k}">${lab}: <b id="nt-${k}-v">${fmt(NT[k])}</b></label>
    <input type="range" id="nt-${k}" data-nt="${k}" min="${min}" max="${max}" step="${step}" value="${NT[k]}">${help ? `<small>${help}</small>` : ''}</div>`;
  const toggle = (k, lab, help) => `<div class="set tg"><span class="sl">${lab}</span><button type="button" class="switch" role="switch" aria-checked="${NT[k]}" aria-label="${lab}" data-act="nt-toggle" data-k="${k}"></button><small>${help}</small></div>`;
  return `<form id="nt-form" class="panel"><h2>New table · No-Limit Hold'em</h2>
    ${slider('size', 'Table Size', 2, 9, 1, v => `${v} max`)}
    ${slider('turn', 'Action Time', 10, 60, 5, v => `${v} sec`)}
    <div class="set"><span class="sl">Blinds: <b id="nt-bl-v">${bl[0]}/${bl[1]}</b></span><div class="seg" id="nt-blinds">${BLINDS.map((b, i) => `<button type="button" data-act="nt-blinds" data-i="${i}" aria-pressed="${NT.blinds === i}">${b[0]}/${b[1]}</button>`).join('')}</div></div>
    <div class="set"><span class="sl">Buy-in</span><div class="two">
      <input class="txt" id="nt-min" data-nt="min" type="number" inputmode="decimal" step="any" min="0" value="${NT.min}" aria-label="Minimum buy-in">
      <input class="txt" id="nt-max" data-nt="max" type="number" inputmode="decimal" step="any" min="0" value="${NT.max}" aria-label="Maximum buy-in"></div><small>Minimum and maximum chips a player can bring.</small></div>
    ${slider('anteBB', 'Ante', 0, 2, 0.25, v => (+v ? `${v} Big Blind` : 'None'), 'Every player puts this in before each hand.')}
    ${slider('fee', 'Fee', 0, 10, 0.5, v => `${v}%`, 'The dealer takes this share of every pot.')}
    ${slider('capBB', 'Fee Cap', 0, 10, 0.5, v => (+v ? `${v} x Big Blind` : 'No cap'), 'The most the dealer takes from one hand.')}
    ${slider('hours', 'Game Length', 1, 24, 1, v => `${v} hour${+v === 1 ? '' : 's'}`, 'The table closes after this and chips go back to balances.')}
    ${toggle('anon', 'Anonymous Table', 'Players see seat numbers instead of usernames. You still see real names.')}
    ${toggle('rathole', 'No Rathole', 'A player who leaves and comes back within 2 hours must bring at least what they left with.')}
    ${toggle('auth', 'Buy-in Authorization', 'You approve every buy-in. Players wait until you do.')}
    ${toggle('nfnd', 'No Flop, No Fee', 'Skip the fee when the hand ends before the flop.')}
    <button class="btn gold" type="submit">Start table</button></form>`;
}
function renderFilters() {
  const f = App.admin.filter;
  setHTML($('#cs-filters'), [['', 'All'], ['deposit', 'Transfers'], ['withdraw', 'Withdrawals'], ['buyin', 'Buy-ins'], ['cashout', 'Cash-outs']].map(([k, l]) =>
    `<button data-act="cs-filter" data-k="${k}" aria-pressed="${f === k}">${l}</button>`).join(''));
}
async function loadLedger() {
  try {
    const r = await api('/api/admin/ledger' + (App.admin.filter ? '?type=' + App.admin.filter : ''));
    setHTML($('#cs-list'), r.items.length ? r.items.map(e => ledgerRow(e, true)).join('') : '<p class="empty">No transactions yet.</p>');
  } catch (e) { setHTML($('#cs-list'), `<p class="empty">${esc(e.message)}</p>`); }
}
function playerSheet(uid) {
  App.admin.player = uid;
  openSheet('player', `<div id="ps-head"></div>
    <h4>Transfer chips</h4>
    <div class="row"><input class="txt" id="ps-amt" type="number" inputmode="decimal" min="0" step="any" placeholder="Amount" aria-label="Amount to transfer"><button class="btn green" data-act="p-send">Send</button></div>
    <input class="txt" id="ps-note" placeholder="Note (optional)" maxlength="80" aria-label="Note">
    <h4>Withdraw chips</h4>
    <div class="row"><input class="txt" id="ps-wamt" type="number" inputmode="decimal" min="0" step="any" placeholder="Amount" aria-label="Amount to withdraw"><button class="btn danger" data-act="p-withdraw">Withdraw</button></div>
    <h4>Account</h4>
    <div class="row"><input class="txt" id="ps-pass" placeholder="New password" autocomplete="new-password" aria-label="New password"><button class="btn" data-act="p-pass">Set</button></div>
    <div id="ps-dis"></div>
    <h4>History</h4><div id="ps-hist" class="list"><p class="empty">Loading…</p></div>
    <button class="btn" data-act="close-sheet">Close</button>`);
  fillPlayerSheet();
}
async function fillPlayerSheet() {
  const uid = App.admin.player, u = App.admin.data && App.admin.data.users.find(x => x.id === uid);
  if (!u) return;
  setHTML($('#ps-head'), `<h3>${esc(u.username)} ${u.disabled ? '<span>Disabled</span>' : ''}</h3>
    <div class="two">${tile('Balance', money(u.wallet), 'gold')}${tile('On tables', money(u.onTable))}</div>`);
  setHTML($('#ps-dis'), `<button class="btn ${u.disabled ? 'green' : 'danger'}" data-act="p-disable" data-v="${u.disabled ? 0 : 1}">${u.disabled ? 'Enable account' : 'Disable account'}</button>`);
  try {
    const r = await api('/api/admin/ledger?uid=' + encodeURIComponent(uid));
    setHTML($('#ps-hist'), r.items.length ? r.items.slice(0, 60).map(e => ledgerRow(e)).join('') : '<p class="empty">No transactions yet.</p>');
  } catch (e) { /* shown elsewhere */ }
}
async function adminDo(path, body, okMsg) {
  try { const r = await api(path, body); if (okMsg) toast(okMsg); loadAdmin(); return r; }
  catch (e) { toast(e.message); return null; }
}

let toastT = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3400);
}

/* ---------- Input ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (e.target.id === 'sheet') closeSheet(); return; }
  const a = b.dataset.act, tv = App.tv;
  switch (a) {
    case 'account': accountSheet(); break;
    case 'logout': try { await api('/api/logout', {}); } catch (err) { /* ignore */ } logoutLocal(); location.hash = ''; break;
    case 'close-sheet': closeSheet(); break;
    case 'open-table': go('t-' + b.dataset.tid); break;
    case 'back': go(home()); break;
    case 'tablemenu': App.sheet = 'tablemenu'; $('#sheet').hidden = false; renderTableMenu(); break;
    case 'sit': buyinSheet('sit', +b.dataset.seat); break;
    case 'add': buyinSheet('add'); break;
    case 'buy-p': { const B = App.buy; B.amt = clamp(Math.round((B.lo + (B.hi - B.lo) * +b.dataset.f) / tv.cfg.sb) * tv.cfg.sb, B.lo, B.hi); if (+b.dataset.f === 1) B.amt = B.hi; syncBuy(); break; }
    case 'buy-go': submitBuy(); break;
    case 'cancel-req': try { await api('/api/table/cancel', { tid: tv.id }); } catch (err) { toast(err.message); } break;
    case 'fold': act('f'); break;
    case 'check': act('k'); break;
    case 'call': act('c'); break;
    case 'r-open': App.raise.open = true; App.raise.amt = tv.me.minTo; renderDock(); break;
    case 'r-cancel': App.raise.open = false; renderDock(); break;
    case 'r-minus': setRaise(App.raise.amt - tv.cfg.bb); break;
    case 'r-plus': setRaise(App.raise.amt + tv.cfg.bb); break;
    case 'preset': {
      const m = tv.me, f = b.dataset.f;
      if (f === 'min') setRaise(m.minTo);
      else if (f === 'max') { App.raise.amt = m.maxTo; syncRaise(); }
      else setRaise(tv.h.cur + parseFloat(f) * (tv.h.pot + m.toCall));
      break;
    }
    case 'r-go': act('r', App.raise.amt); break;
    case 'pre-cf': App.pre = App.pre === 'cf' ? null : 'cf'; renderDock(); break;
    case 'sitout': case 'backin':
      try { await api('/api/table/sitout', { tid: tv.id, on: a === 'sitout' }); closeSheet(); } catch (err) { toast(err.message); }
      break;
    case 'leave':
      try { const r = await api('/api/table/leave', { tid: tv.id }); closeSheet(); toast(r.later ? "You'll stand up when this hand ends. Your chips go back to your balance." : 'Your chips are back in your balance.'); }
      catch (err) { toast(err.message); }
      break;
    case 'close-table': {
      const r = await adminDo('/api/admin/tables/close', { tid: b.dataset.tid });
      if (r) { toast(r.later ? 'The table closes after this hand.' : 'Table closed. Chips went back to balances.'); if (App.sheet === 'tablemenu') closeSheet(); }
      break;
    }
    case 'atab': go('admin-' + b.dataset.k); break;
    case 'req': adminDo('/api/admin/requests/decide', { rid: b.dataset.rid, ok: b.dataset.ok === '1' }, b.dataset.ok === '1' ? 'Approved' : 'Declined'); break;
    case 'player': playerSheet(b.dataset.uid); break;
    case 'p-send': {
      const amt = $('#ps-amt').value;
      if (await adminDo('/api/admin/transfer', { uid: App.admin.player, amount: amt, note: $('#ps-note').value }, `Sent ${amt} chips`)) { $('#ps-amt').value = ''; $('#ps-note').value = ''; }
      break;
    }
    case 'p-withdraw': {
      const amt = $('#ps-wamt').value;
      if (await adminDo('/api/admin/withdraw', { uid: App.admin.player, amount: amt }, `Withdrew ${amt} chips`)) $('#ps-wamt').value = '';
      break;
    }
    case 'p-pass':
      if (await adminDo('/api/admin/users/password', { uid: App.admin.player, password: $('#ps-pass').value }, 'Password changed. They need to log in again.')) $('#ps-pass').value = '';
      break;
    case 'p-disable': adminDo('/api/admin/users/disable', { uid: App.admin.player, disabled: b.dataset.v === '1' }, b.dataset.v === '1' ? 'Account disabled' : 'Account enabled'); break;
    case 'cs-filter': App.admin.filter = b.dataset.k; renderFilters(); loadLedger(); break;
    case 'nt-blinds': {
      NT.blinds = +b.dataset.i;
      const bl = BLINDS[NT.blinds];
      NT.min = +(bl[1] * 20).toFixed(2); NT.max = +(bl[1] * 250).toFixed(2);
      $('#nt-min').value = NT.min; $('#nt-max').value = NT.max;
      $('#nt-bl-v').textContent = `${bl[0]}/${bl[1]}`;
      document.querySelectorAll('#nt-blinds button').forEach((x, i) => x.setAttribute('aria-pressed', String(i === NT.blinds)));
      break;
    }
    case 'nt-toggle': NT[b.dataset.k] = !NT[b.dataset.k]; b.setAttribute('aria-checked', String(NT[b.dataset.k])); break;
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'r-slider') { App.raise.amt = +t.value; syncRaise(); }
  if (t.id === 'buy-slider') { App.buy.amt = +t.value; syncBuy(); }
  if (t.dataset && t.dataset.nt) {
    const k = t.dataset.nt; NT[k] = +t.value;
    const lab = $('#nt-' + k + '-v');
    if (lab) {
      const v = NT[k];
      lab.textContent = { size: `${v} max`, turn: `${v} sec`, anteBB: v ? `${v} Big Blind` : 'None', fee: `${v}%`, capBB: v ? `${v} x Big Blind` : 'No cap', hours: `${v} hour${v === 1 ? '' : 's'}` }[k] || v;
    }
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'auth-form') submitAuth();
  if (f.id === 'pw-form') {
    try { await api('/api/password', { current: $('#pw-cur').value, next: $('#pw-new').value }); toast('Password changed.'); closeSheet(); }
    catch (err) { toast(err.message); }
  }
  if (f.id === 'np-form') {
    const body = { username: $('#np-user').value.trim(), password: $('#np-pass').value, chips: $('#np-chips').value || 0 };
    if (await adminDo('/api/admin/users', body, `Created ${body.username}`)) { $('#np-user').value = ''; $('#np-pass').value = ''; $('#np-chips').value = ''; }
  }
  if (f.id === 'nt-form') {
    const bl = BLINDS[NT.blinds];
    const r = await adminDo('/api/admin/tables', {
      size: NT.size, turn: NT.turn, sb: bl[0], bb: bl[1], min: +$('#nt-min').value, max: +$('#nt-max').value,
      anteBB: NT.anteBB, fee: NT.fee, capBB: NT.capBB, hours: NT.hours, anon: NT.anon, rathole: NT.rathole, auth: NT.auth, nfnd: NT.nfnd
    }, 'Table started. Players can sit down now.');
    if (r) $('#a-scroll').scrollTop = $('#tb-list').offsetTop - 60;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
window.addEventListener('resize', () => { if (App.view === 'table') { computeLayout(); renderTable(); } });
setInterval(() => { if (App.view === 'lobby') renderLobby(); if (App.view === 'table' && App.tv) $('#t-meta').textContent = `${App.tv.cfg.size}-max · ${timeLeft(App.tv.endsAt)}`; }, 30000);

/* ---------- Start ---------- */
(async function boot() {
  try {
    const s = await api('/api/session');
    App.user = s.user; App.setup = s.needsSetup;
  } catch (e) { toast(e.message); }
  if (!App.user) return show('auth');
  if (!location.hash || location.hash === '#') location.replace('#' + home());
  route();
})();
