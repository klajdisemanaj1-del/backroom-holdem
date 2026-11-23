'use strict';
/*
 * Backroom Hold'em server: No-Limit Hold'em cash tables with a neutral server-side dealer,
 * admin-created accounts, a chip cashier and a house fee. Node 18+, no dependencies.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { E, newState, newSeat, evalBest, handName, startingHandName, money } = require('./engine');

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const TZ = process.env.TZ || 'Europe/Tirane';
const SESSION_MS = 30 * 864e5;
const RATHOLE_MS = 2 * 3600e3;      // No Rathole: leave and come back within 2h -> buy in for at least what you left with
const IDLE_STAND_MS = 10 * 60e3;    // sitting out or busted for 10 min -> stood up and cashed out
const REQUEST_MS = 5 * 60e3;        // buy-in requests expire after 5 min

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

/* ================= Storage ================= */
let db;
function freshDb() {
  return {
    users: {}, sessions: {}, ledger: [], tables: {}, requests: {},
    totals: { deposits: 0, withdrawals: 0 },
    rake: { total: 0, byDay: {}, byTable: {}, recent: [] },
    seq: { ledger: 0 }, created: Date.now()
  };
}
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { console.error(`Could not read ${DB_FILE}:`, e.message); process.exit(1); }
    db = freshDb();
  }
  db = Object.assign(freshDb(), db);
}
let saveTimer = null;
function save() { if (!saveTimer) saveTimer = setTimeout(flushDb, 300); }
function flushDb() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(9).toString('base64url');
const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });

/* ================= Accounts ================= */
async function hashPw(pw, salt) { return (await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex'); }
async function checkPw(u, pw) {
  const h = Buffer.from(await hashPw(pw, u.salt), 'hex');
  const s = Buffer.from(u.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
const findUser = name => Object.values(db.users).find(u => u.username.toLowerCase() === String(name).toLowerCase());
function validUsername(n) {
  n = String(n || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(n)) bad('Usernames are 3 to 20 letters, numbers, dots, dashes or underscores.');
  return n;
}
function validPassword(p) {
  p = String(p || '');
  if (p.length < 6 || p.length > 100) bad('Passwords need at least 6 characters.');
  return p;
}
async function createUser(username, password, role) {
  username = validUsername(username); password = validPassword(password);
  if (findUser(username)) bad('That username is taken.');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: 'u' + newId(), username, role, salt, hash: await hashPw(password, salt), wallet: 0, disabled: false, created: Date.now(), lastLogin: 0 };
  db.users[u.id] = u; save();
  return u;
}
function newSession(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { uid: u.id, exp: Date.now() + SESSION_MS };
  u.lastLogin = Date.now(); save();
  return token;
}
function killSessions(uid) { for (const [k, s] of Object.entries(db.sessions)) if (s.uid === uid) delete db.sessions[k]; save(); }
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function userOf(req) {
  const tok = cookies(req).sid;
  if (!tok) return null;
  const s = db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return null;
  const u = db.users[s.uid];
  return u && !u.disabled ? u : null;
}
function setCookie(req, res, token, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
const needUser = u => u || bad('Please log in.', 401);
const needAdmin = u => (needUser(u).role === 'admin' ? u : bad('Admins only.', 403));
const needPlayer = u => (needUser(u).role === 'player' ? u : bad('The admin account watches but does not play. Make yourself a player account to play.', 403));
const pubUser = u => ({ id: u.id, username: u.username, role: u.role, wallet: u.wallet });

// Login throttling: 5 wrong passwords for one username locks it for 10 minutes.
const fails = new Map();
function locked(key) { const f = fails.get(key); return !!(f && f.until > Date.now()); }
function failed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0; }
  fails.set(key, f);
}

/* ================= Money ================= */
function cents(x, what = 'amount') {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) bad(`Enter an ${what}.`);
  const c = Math.round(n * 100);
  if (c <= 0 || c > 1e12) bad(`That ${what} isn't allowed.`);
  return c;
}
function addLedger(e) {
  e.id = ++db.seq.ledger; e.t = Date.now();
  db.ledger.push(e);
  if (db.ledger.length > 50000) db.ledger.splice(0, db.ledger.length - 50000);
  dirty.admin = true; save();
  return e;
}
function move(u, amount, type, extra) {
  u.wallet += amount;
  addLedger(Object.assign({ type, uid: u.id, username: u.username, amount, bal: u.wallet }, extra));
  dirty.users.add(u.id); schedule();
}
function recordRake(T, h) {
  const r = db.rake, d = dayKey();
  r.total += h.rake;
  r.byDay[d] = (r.byDay[d] || 0) + h.rake;
  r.byTable[T.id] = (r.byTable[T.id] || 0) + h.rake;
  r.recent.push({ t: Date.now(), table: T.id, label: label(T), hand: h.id, pot: h.pot, fee: h.rake });
  if (r.recent.length > 2000) r.recent.splice(0, r.recent.length - 2000);
  dirty.admin = true;
}

/* ================= Tables ================= */
const decks = new Map(); // dealt cards live only in server memory
const deckOf = T => { if (!decks.has(T.id)) decks.set(T.id, { hid: -1, deck: [], holes: {} }); return decks.get(T.id); };
const label = T => `NLH ${money(T.cfg.sb)}/${money(T.cfg.bb)}`;
const openTables = () => Object.values(db.tables).filter(T => T.status === 'open');
function getOpenTable(id) { const T = db.tables[String(id || '')]; if (!T || T.status !== 'open') bad('That table is closed.', 404); return T; }
const pendingFor = (tid, uid) => Object.values(db.requests).find(r => r.tid === tid && r.uid === uid);
const seatReserved = (tid, seat) => Object.values(db.requests).find(r => r.tid === tid && r.kind === 'sit' && r.seat === seat);
const seatOf = (T, uid) => T.state.seats.findIndex(s => s && s.pid === uid);

function makeCfg(b) {
  const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) bad(`${name} must be between ${lo} and ${hi}.`); return n; };
  const sb = Math.round(num(b.sb, 0.01, 1e6, 'Small blind') * 100);
  const bb = Math.round(num(b.bb, 0.01, 1e6, 'Big blind') * 100);
  if (bb < sb) bad('The big blind must be at least the small blind.');
  const min = Math.round(num(b.min, 0.01, 1e9, 'Minimum buy-in') * 100);
  const max = Math.round(num(b.max, 0.01, 1e9, 'Maximum buy-in') * 100);
  if (min < bb) bad('The minimum buy-in must be at least one big blind.');
  if (max < min) bad('The maximum buy-in must be at least the minimum.');
  const anteBB = num(b.anteBB || 0, 0, 5, 'Ante');
  const fee = num(b.fee || 0, 0, 20, 'Fee');
  const capBB = num(b.capBB || 0, 0, 50, 'Fee cap');
  return {
    sb, bb, min, max, anteBB, ante: Math.round(anteBB * bb), fee, capBB, cap: Math.round(capBB * bb),
    size: Math.round(num(b.size, 2, 9, 'Table size')), turn: Math.round(num(b.turn, 5, 120, 'Action time')),
    hours: num(b.hours, 0.5, 72, 'Game length'),
    anon: !!b.anon, rathole: !!b.rathole, auth: !!b.auth, nfnd: !!b.nfnd
  };
}
const pubCfg = c => ({ sb: c.sb, bb: c.bb, min: c.min, max: c.max, ante: c.ante, anteBB: c.anteBB, fee: c.fee, cap: c.cap, capBB: c.capBB, size: c.size, turn: c.turn, hours: c.hours, anon: c.anon, rathole: c.rathole, auth: c.auth, nfnd: c.nfnd });

function limits(T, u) {
  const c = T.cfg, L = T.lefts[u.id];
  const rh = c.rathole && L && Date.now() - L.t < RATHOLE_MS ? L.amt : 0;
  return { min: Math.max(c.min, rh), max: Math.max(c.max, rh), rathole: rh > c.min ? rh : 0 };
}

// Every change to a table goes through here: pays out leavers, books the fee, saves, pushes updates.
function changed(T) {
  const S = T.state;
  S.v++;
  while (S.out.length) {
    const o = S.out.shift(), u = db.users[o.pid];
    if (!u) continue;
    if (o.stack > 0) move(u, o.stack, 'cashout', { table: T.id, note: label(T) });
    T.lefts[u.id] = { amt: o.stack, t: Date.now() };
  }
  if (S.h.ph === 'show' && T.doneHand !== S.h.id) {
    T.doneHand = S.h.id; T.hands = (T.hands || 0) + 1;
    if (S.h.rake > 0) recordRake(T, S.h);
  }
  dirty.tables.add(T.id); dirty.lobby = true; dirty.admin = true;
  save(); schedule();
}
function beforeStart(T) {
  if (T.closing) return false;
  const S = T.state, now = Date.now();
  S.seats.forEach(s => { if (s && !s.so && !online(T.id, s.pid)) { s.so = true; s.soAt = now; E.log(S, `${s.nick} is away and sits out`); } });
  return true;
}
function closeTable(T, why) {
  const S = T.state;
  if (E.live(S)) E.voidHand(S, 'The table closed during the hand. Bets were returned.');
  S.seats.forEach((s, i) => { if (s) { S.out.push({ pid: s.pid, stack: s.stack + s.tot, seat: i }); S.seats[i] = null; } });
  for (const r of Object.values(db.requests)) if (r.tid === T.id) { delete db.requests[r.id]; notify(r.uid, 'Your buy-in request was cancelled because the table closed.'); }
  T.status = 'closed'; T.closing = false; T.closedAt = Date.now();
  E.log(S, why || 'Table closed.');
  decks.delete(T.id);
  changed(T);
}
function doSit(T, u, seat, amount) {
  const S = T.state;
  if (S.seats[seat]) bad('That seat was just taken.');
  if (seatOf(T, u.id) >= 0) bad("You're already seated at this table.");
  if (u.wallet < amount) bad(`Your balance is ${money(u.wallet)}. Ask the admin for chips.`);
  move(u, -amount, 'buyin', { table: T.id, note: label(T) });
  const nick = T.cfg.anon ? `Seat ${seat + 1}` : u.username;
  S.seats[seat] = newSeat(u.id, nick, u.username, amount);
  delete T.lefts[u.id];
  E.log(S, `${nick} sits down with ${money(amount)}`);
  changed(T);
}
function canAddNow(T, s) { return !(E.live(T.state) && (E.inHand(s) || s.tot > 0)); }
function doAdd(T, u, amount) {
  const S = T.state, i = seatOf(T, u.id);
  if (i < 0) bad("You're not seated at this table.");
  const s = S.seats[i];
  if (!canAddNow(T, s)) bad('You can add chips once this hand is over.');
  const lim = limits(T, u);
  if (s.stack + amount > lim.max) bad(`You can have at most ${money(lim.max)} on the table.`);
  if (u.wallet < amount) bad(`Your balance is ${money(u.wallet)}. Ask the admin for chips.`);
  move(u, -amount, 'buyin', { table: T.id, note: label(T) });
  s.stack += amount; s.buyin += amount;
  if (s.so && s.to === 0) s.so = false;
  E.log(S, `${s.nick} adds ${money(amount)}`);
  changed(T);
}
function createRequest(T, u, kind, seat, amount) {
  const r = { id: 'r' + newId(), tid: T.id, uid: u.id, kind, seat, amount, t: Date.now() };
  db.requests[r.id] = r;
  dirty.admin = true; dirty.tables.add(T.id); save(); schedule();
  notifyAdmins(`${u.username} asks to ${kind === 'sit' ? 'buy in' : 'add'} ${money(amount)} at ${label(T)}`);
  return r;
}

/* ================= Views (each player only ever receives their own cards) ================= */
function tableView(T, u) {
  if (!T || T.status !== 'open') return { closed: true, id: T ? T.id : null };
  const S = T.state, P = deckOf(T), h = S.h, now = Date.now();
  const isAdmin = u.role === 'admin', mi = seatOf(T, u.id);
  const seats = S.seats.map((s, i) => {
    if (!s) { const r = seatReserved(T.id, i); return r ? { reserved: true, mine: r.uid === u.id } : null; }
    const me = s.pid === u.id;
    let cards = s.c || null;
    if (!cards && me && E.live(S) && P.hid === h.id && P.holes[i] && s.st !== 'o') cards = P.holes[i];
    return {
      name: me || isAdmin ? s.uname : s.nick, me, stack: s.stack, bet: s.bet, st: s.st, last: s.last, so: s.so,
      cards, inHand: E.live(S) && E.inHand(s), away: !online(T.id, s.pid)
    };
  });
  let me = null;
  if (mi >= 0) {
    const s = S.seats[mi], cards = seats[mi].cards;
    let hand = '';
    if (cards && s.st !== 'o') hand = h.board.length >= 3 ? handName(evalBest(cards.concat(h.board))) : startingHandName(cards);
    const maxTo = s.bet + s.stack;
    me = {
      seat: mi, hand, net: s.stack + s.tot - s.buyin, toCall: Math.max(0, h.cur - s.bet),
      canRaise: !s.act && s.stack > Math.max(0, h.cur - s.bet), minTo: Math.min(maxTo, h.cur + h.minR), maxTo,
      canAdd: canAddNow(T, s)
    };
  }
  const pend = pendingFor(T.id, u.id);
  return {
    id: T.id, v: S.v, label: label(T), cfg: pubCfg(T.cfg), endsAt: T.endsAt, closing: !!T.closing,
    seats, me, wallet: u.wallet, isAdmin,
    limits: u.role === 'player' ? limits(T, u) : null,
    pending: pend ? { kind: pend.kind, seat: pend.seat, amount: pend.amount } : null,
    h: {
      id: h.id, ph: h.ph, btn: h.btn, board: h.board, cur: h.cur, minR: h.minR, toAct: h.toAct, run: h.run,
      left: h.toAct >= 0 ? Math.max(0, h.dl - now) : 0, res: h.res, won: h.won, rake: h.ph === 'show' ? h.rake : 0,
      pot: E.live(S) ? E.potTotal(S) : 0
    },
    log: S.log.slice(-30)
  };
}
function lobbyFor(u) {
  return {
    me: pubUser(u),
    tables: openTables().sort((a, b) => a.created - b.created).map(T => ({
      id: T.id, label: label(T), cfg: pubCfg(T.cfg), endsAt: T.endsAt, closing: !!T.closing,
      seated: T.state.seats.filter(Boolean).length, playing: E.live(T.state),
      mine: seatOf(T, u.id) >= 0, pending: !!pendingFor(T.id, u.id)
    }))
  };
}
function overview() {
  const users = Object.values(db.users);
  const onTable = {}, at = {};
  let tableChips = 0;
  for (const T of openTables()) T.state.seats.forEach(s => {
    if (!s) return;
    const v = s.stack + s.tot;
    onTable[s.pid] = (onTable[s.pid] || 0) + v; tableChips += v;
    (at[s.pid] = at[s.pid] || []).push(label(T));
  });
  const wallets = users.reduce((a, u) => a + u.wallet, 0);
  const issued = db.totals.deposits - db.totals.withdrawals;
  const days = [];
  for (let k = 13; k >= 0; k--) { const d = dayKey(Date.now() - k * 864e5); days.push({ day: d, amt: db.rake.byDay[d] || 0 }); }
  return {
    totals: {
      deposits: db.totals.deposits, withdrawals: db.totals.withdrawals, issued, wallets, tables: tableChips,
      rake: db.rake.total, today: db.rake.byDay[dayKey()] || 0, balanced: issued === wallets + tableChips + db.rake.total
    },
    users: users.filter(u => u.role === 'player').sort((a, b) => a.username.localeCompare(b.username)).map(u => ({
      id: u.id, username: u.username, wallet: u.wallet, onTable: onTable[u.id] || 0, at: at[u.id] || [],
      disabled: u.disabled, created: u.created, lastLogin: u.lastLogin, online: [...clients].some(c => c.uid === u.id)
    })),
    requests: Object.values(db.requests).sort((a, b) => a.t - b.t).map(r => {
      const u = db.users[r.uid], T = db.tables[r.tid];
      return { id: r.id, kind: r.kind, seat: r.seat, amount: r.amount, t: r.t, username: u ? u.username : '?', wallet: u ? u.wallet : 0, label: T ? label(T) : '?' };
    }),
    tables: Object.values(db.tables).sort((a, b) => b.created - a.created).slice(0, 40).map(T => ({
      id: T.id, label: label(T), cfg: pubCfg(T.cfg), status: T.status, closing: !!T.closing, endsAt: T.endsAt,
      created: T.created, closedAt: T.closedAt || 0, hands: T.hands || 0, rake: db.rake.byTable[T.id] || 0,
      players: T.state.seats.filter(Boolean).map(s => ({ name: s.uname, stack: s.stack + s.tot }))
    })),
    rakeDays: days,
    rakeRecent: db.rake.recent.slice(-80).reverse()
  };
}

/* ================= Live updates (Server-Sent Events) ================= */
const clients = new Set();
let clientSeq = 0;
const dirty = { tables: new Set(), users: new Set(), lobby: false, admin: false };
let flushTimer = null, lastLobby = 0;
const online = (tid, uid) => { for (const c of clients) if (c.tid === tid && c.uid === uid) return true; return false; };
function sendTo(c, event, data) { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ } }
function schedule() { if (!flushTimer) flushTimer = setTimeout(flushOut, 40); }
function flushOut() {
  flushTimer = null;
  const now = Date.now();
  const lobbyAll = dirty.lobby && now - lastLobby > 800;
  if (lobbyAll) { lastLobby = now; dirty.lobby = false; }
  for (const c of clients) {
    const u = db.users[c.uid];
    if (!u || u.disabled) { try { c.res.end(); } catch (e) {} clients.delete(c); continue; }
    if (c.tid && dirty.tables.has(c.tid)) sendTo(c, 'table', tableView(db.tables[c.tid], u));
    if (lobbyAll || dirty.users.has(u.id)) sendTo(c, 'lobby', lobbyFor(u));
    if (dirty.admin && u.role === 'admin') sendTo(c, 'admin', {});
  }
  dirty.tables.clear(); dirty.users.clear(); dirty.admin = false;
  if (dirty.lobby) setTimeout(schedule, 850);
}
function notify(uid, msg) { for (const c of clients) if (c.uid === uid) sendTo(c, 'note', { msg }); }
function notifyAdmins(msg) { for (const c of clients) { const u = db.users[c.uid]; if (u && u.role === 'admin') sendTo(c, 'note', { msg }); } }
function stream(req, res, url) {
  const u = userOf(req);
  if (!u) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Please log in.'); }
  const tid = url.searchParams.get('t');
  const T = tid && db.tables[tid] && db.tables[tid].status === 'open' ? db.tables[tid] : null;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const c = { id: ++clientSeq, res, uid: u.id, tid: T ? T.id : null };
  clients.add(c);
  sendTo(c, 'lobby', lobbyFor(u));
  if (T) { sendTo(c, 'table', tableView(T, u)); dirty.tables.add(T.id); schedule(); }
  else if (tid) sendTo(c, 'table', { closed: true, id: tid });
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(ka); clients.delete(c); if (c.tid) { dirty.tables.add(c.tid); schedule(); } dirty.admin = true; });
}

/* ================= API ================= */
const GET = {}, POST = {};

GET['/api/session'] = ({ user }) => ({ user: user ? pubUser(user) : null, needsSetup: Object.keys(db.users).length === 0 });

POST['/api/setup'] = async ({ req, res, body }) => {
  if (Object.keys(db.users).length) bad('Setup is already done. Log in instead.', 403);
  const u = await createUser(body.username, body.password, 'admin');
  setCookie(req, res, newSession(u), SESSION_MS / 1000);
  return { user: pubUser(u) };
};
POST['/api/login'] = async ({ req, res, body }) => {
  const name = String(body.username || '').trim().toLowerCase();
  if (!name || !body.password) bad('Enter your username and password.');
  if (locked('u:' + name)) bad('Too many wrong passwords. Try again in 10 minutes.', 429);
  const u = findUser(name);
  const ok = u ? await checkPw(u, String(body.password)) : (await hashPw(String(body.password), 'x'), false);
  if (!ok) { failed('u:' + name); bad('Wrong username or password.', 401); }
  if (u.disabled) bad('This account is disabled. Contact the admin.', 403);
  fails.delete('u:' + name);
  setCookie(req, res, newSession(u), SESSION_MS / 1000);
  return { user: pubUser(u) };
};
POST['/api/logout'] = ({ req, res }) => {
  const tok = cookies(req).sid;
  if (tok) { delete db.sessions[sha(tok)]; save(); }
  setCookie(req, res, '', 0);
  return { ok: true };
};
POST['/api/password'] = async ({ user, body }) => {
  const u = needUser(user);
  if (!(await checkPw(u, String(body.current || '')))) bad('Your current password is wrong.');
  const pw = validPassword(body.next);
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(pw, u.salt);
  save();
  return { ok: true };
};
GET['/api/lobby'] = ({ user }) => lobbyFor(needUser(user));
GET['/api/my/ledger'] = ({ user }) => {
  const u = needUser(user);
  return { items: db.ledger.filter(e => e.uid === u.id).slice(-150).reverse().map(e => ({ t: e.t, type: e.type, amount: e.amount, bal: e.bal, note: e.note || '' })) };
};

POST['/api/table/sit'] = ({ user, body }) => {
  const u = needPlayer(user), T = getOpenTable(body.tid);
  if (T.closing) bad('This table is closing.');
  const seat = Number(body.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat >= T.cfg.size) bad('Pick a seat.');
  const amount = cents(body.amount, 'buy-in');
  const lim = limits(T, u);
  if (amount < lim.min || amount > lim.max) bad(`Buy in for between ${money(lim.min)} and ${money(lim.max)}.`);
  if (T.state.seats[seat] || seatReserved(T.id, seat)) bad('That seat is taken.');
  if (seatOf(T, u.id) >= 0) bad("You're already seated at this table.");
  if (pendingFor(T.id, u.id)) bad('You already have a request waiting for approval.');
  if (u.wallet < amount) bad(`Your balance is ${money(u.wallet)}. Ask the admin for chips.`);
  if (T.cfg.auth) { createRequest(T, u, 'sit', seat, amount); return { pending: true }; }
  doSit(T, u, seat, amount);
  return { ok: true };
};
POST['/api/table/add'] = ({ user, body }) => {
  const u = needPlayer(user), T = getOpenTable(body.tid);
  const amount = cents(body.amount);
  const i = seatOf(T, u.id);
  if (i < 0) bad("You're not seated at this table.");
  if (pendingFor(T.id, u.id)) bad('You already have a request waiting for approval.');
  const lim = limits(T, u), s = T.state.seats[i];
  if (s.stack + amount > lim.max) bad(`You can have at most ${money(lim.max)} on the table.`);
  if (u.wallet < amount) bad(`Your balance is ${money(u.wallet)}. Ask the admin for chips.`);
  if (T.cfg.auth) { createRequest(T, u, 'add', i, amount); return { pending: true }; }
  doAdd(T, u, amount);
  return { ok: true };
};
POST['/api/table/cancel'] = ({ user, body }) => {
  const u = needPlayer(user), T = getOpenTable(body.tid), r = pendingFor(T.id, u.id);
  if (r) { delete db.requests[r.id]; dirty.admin = true; dirty.tables.add(T.id); save(); schedule(); }
  return { ok: true };
};
POST['/api/table/act'] = ({ user, body }) => {
  const u = needPlayer(user), T = getOpenTable(body.tid), S = T.state;
  const i = seatOf(T, u.id);
  if (i < 0) bad("You're not seated.");
  if (body.hid !== S.h.id) bad('That hand is already over.', 409);
  const a = String(body.a);
  if (!['f', 'k', 'c', 'r'].includes(a)) bad('Unknown action.');
  const amt = a === 'r' ? cents(body.amt, 'amount') : 0;
  if (!E.act(S, deckOf(T), i, a, amt, Date.now(), false)) bad("It's not your turn.", 409);
  changed(T);
  return { ok: true };
};
POST['/api/table/sitout'] = ({ user, body }) => {
  const u = needPlayer(user), T = getOpenTable(body.tid), i = seatOf(T, u.id);
  if (i < 0) bad("You're not seated.");
  const s = T.state.seats[i];
  s.so = !!body.on; s.to = 0; s.soAt = s.so ? Date.now() : 0;
  E.log(T.state, s.so ? `${s.nick} sits out` : `${s.nick} is back`);
  changed(T);
  return { ok: true };
};
POST['/api/table/leave'] = ({ user, body }) => {
  const u = needPlayer(user), T = getOpenTable(body.tid), i = seatOf(T, u.id);
  const r = pendingFor(T.id, u.id);
  if (r) delete db.requests[r.id];
  if (i < 0) { changed(T); return { ok: true }; }
  const s = T.state.seats[i];
  E.log(T.state, `${s.nick} leaves the table`);
  E.leave(T.state, deckOf(T), i, Date.now());
  changed(T);
  return { ok: true, later: !!(T.state.seats[i] && T.state.seats[i].lv) };
};

/* ---- Admin ---- */
GET['/api/admin/overview'] = ({ user }) => { needAdmin(user); return overview(); };
GET['/api/admin/ledger'] = ({ user, url }) => {
  needAdmin(user);
  const uid = url.searchParams.get('uid'), type = url.searchParams.get('type');
  let items = db.ledger;
  if (uid) items = items.filter(e => e.uid === uid);
  if (type) items = items.filter(e => e.type === type);
  return { items: items.slice(-300).reverse() };
};
POST['/api/admin/users'] = async ({ user, body }) => {
  const admin = needAdmin(user);
  const u = await createUser(body.username, body.password, 'player');
  if (body.chips) {
    const amt = cents(body.chips);
    db.totals.deposits += amt;
    move(u, amt, 'deposit', { by: admin.username, note: 'Opening balance' });
  }
  dirty.admin = true; schedule();
  return { user: pubUser(u) };
};
POST['/api/admin/users/password'] = async ({ user, body }) => {
  needAdmin(user);
  const u = db.users[body.uid];
  if (!u) bad('No such player.', 404);
  const pw = validPassword(body.password);
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(pw, u.salt);
  killSessions(u.id);
  return { ok: true };
};
POST['/api/admin/users/disable'] = ({ user, body }) => {
  needAdmin(user);
  const u = db.users[body.uid];
  if (!u || u.role !== 'player') bad('No such player.', 404);
  u.disabled = !!body.disabled;
  if (u.disabled) {
    killSessions(u.id);
    for (const T of openTables()) { const i = seatOf(T, u.id); if (i >= 0) { E.leave(T.state, deckOf(T), i, Date.now()); changed(T); } }
    for (const r of Object.values(db.requests)) if (r.uid === u.id) delete db.requests[r.id];
  }
  dirty.admin = true; save(); schedule();
  return { ok: true };
};
POST['/api/admin/transfer'] = ({ user, body }) => {
  const admin = needAdmin(user), u = db.users[body.uid];
  if (!u || u.role !== 'player') bad('No such player.', 404);
  const amt = cents(body.amount);
  db.totals.deposits += amt;
  move(u, amt, 'deposit', { by: admin.username, note: String(body.note || '').slice(0, 80) });
  notify(u.id, `You received ${money(amt)} chips.`);
  return { ok: true, wallet: u.wallet };
};
POST['/api/admin/withdraw'] = ({ user, body }) => {
  const admin = needAdmin(user), u = db.users[body.uid];
  if (!u || u.role !== 'player') bad('No such player.', 404);
  const amt = cents(body.amount);
  if (amt > u.wallet) bad(`${u.username} only has ${money(u.wallet)} in their balance. Chips on a table must be cashed out first.`);
  db.totals.withdrawals += amt;
  move(u, -amt, 'withdraw', { by: admin.username, note: String(body.note || '').slice(0, 80) });
  notify(u.id, `${money(amt)} chips were withdrawn from your balance.`);
  return { ok: true, wallet: u.wallet };
};
POST['/api/admin/tables'] = ({ user, body }) => {
  needAdmin(user);
  const cfg = makeCfg(body);
  const T = { id: 't' + newId(), cfg, created: Date.now(), endsAt: Date.now() + cfg.hours * 3600e3, status: 'open', closing: false, hands: 0, lefts: {}, state: newState(cfg) };
  E.log(T.state, `Table opened: ${label(T)}, ${cfg.size}-max`);
  db.tables[T.id] = T;
  changed(T);
  return { id: T.id };
};
POST['/api/admin/tables/close'] = ({ user, body }) => {
  needAdmin(user);
  const T = getOpenTable(body.tid);
  if (E.live(T.state)) { T.closing = true; E.log(T.state, 'The admin is closing the table after this hand.'); changed(T); return { later: true }; }
  closeTable(T, 'The admin closed the table. Chips went back to balances.');
  return { ok: true };
};
POST['/api/admin/requests/decide'] = ({ user, body }) => {
  needAdmin(user);
  const r = db.requests[body.rid];
  if (!r) bad('That request is gone (it was cancelled or expired).', 404);
  delete db.requests[r.id];
  dirty.admin = true; save(); schedule();
  const u = db.users[r.uid], T = db.tables[r.tid];
  if (!body.ok) { notify(r.uid, 'Your buy-in request was declined.'); if (T) { dirty.tables.add(T.id); schedule(); } return { ok: true }; }
  if (!u || !T || T.status !== 'open') bad('That table is closed.');
  try {
    if (r.kind === 'sit') doSit(T, u, r.seat, r.amount); else doAdd(T, u, r.amount);
  } catch (e) {
    notify(r.uid, `Your buy-in couldn't go through: ${e.message}`);
    dirty.tables.add(T.id); schedule();
    throw e;
  }
  notify(r.uid, `Approved: ${money(r.amount)} chips. Good luck!`);
  return { ok: true };
};

/* ================= HTTP plumbing ================= */
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
function secHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', ch => { size += ch.length; if (size > 64 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new HttpError(400, 'Bad request.')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  secHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res, url);
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(PUBLIC, file)));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const user = userOf(req);
    if (req.method === 'GET' && GET[url.pathname]) return send(res, 200, await GET[url.pathname]({ req, res, url, user }));
    if (req.method === 'POST' && POST[url.pathname]) {
      // CSRF protection: JSON only, same origin only.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) bad('Unsupported request.', 415);
      if (req.headers.origin) { let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch (e) {} if (!ok) bad('Cross-site request blocked.', 403); }
      const body = await readJson(req);
      return send(res, 200, await POST[url.pathname]({ req, res, url, user, body: body && typeof body === 'object' ? body : {} }));
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else { console.error(e); send(res, 500, { error: 'Something went wrong on the server.' }); }
  }
});

/* ================= Start ================= */
async function bootstrapAdmin() {
  // Safer first run: create the admin from environment variables instead of the web setup page.
  const name = process.env.ADMIN_USERNAME, pw = process.env.ADMIN_PASSWORD;
  if (name && pw && Object.keys(db.users).length === 0) {
    await createUser(name, pw, 'admin');
    flushDb();
    console.log(`Admin account "${name}" created.`);
  }
}
loadDb();
for (const T of openTables()) {
  T.lefts = T.lefts || {};
  if (E.live(T.state)) E.voidHand(T.state, 'The server restarted. The hand was cancelled and bets returned.');
  T.state.h.next = 0;
  changed(T);
}
for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
flushDb();

setInterval(() => {
  const now = Date.now();
  for (const T of openTables()) {
    const S = T.state, P = deckOf(T);
    let ch = false;
    if (!T.closing && now >= T.endsAt) { T.closing = true; E.log(S, 'Game length reached. This is the last hand.'); ch = true; }
    if (T.closing && !E.live(S)) { closeTable(T, "Table closed. Chips went back to players' balances."); continue; }
    try { if (E.tick(S, P, now, () => beforeStart(T))) ch = true; }
    catch (e) { console.error('tick', T.id, e); E.voidHand(S, 'Something went wrong. The hand was cancelled and bets returned.'); ch = true; }
    for (let i = 0; i < S.seats.length; i++) {
      const s = S.seats[i];
      if (!s) continue;
      const idle = s.so || s.stack === 0, busy = E.live(S) && (E.inHand(s) || s.tot > 0);
      if (idle && !busy) {
        if (!s.soAt) s.soAt = now;
        else if (now - s.soAt > IDLE_STAND_MS) { E.log(S, `${s.nick} was stood up after sitting out`); E.leave(S, P, i, now); ch = true; }
      } else if (!idle) s.soAt = 0;
    }
    if (ch) changed(T);
  }
  for (const r of Object.values(db.requests)) {
    if (now - r.t > REQUEST_MS) { delete db.requests[r.id]; notify(r.uid, 'Your buy-in request expired. Try again.'); dirty.admin = true; dirty.tables.add(r.tid); save(); schedule(); }
  }
}, 250);

process.on('SIGTERM', () => { flushDb(); process.exit(0); });
process.on('SIGINT', () => { flushDb(); process.exit(0); });
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('WARNING: no volume attached. Players and balances will be lost on every restart. Attach a volume to this service.');
}
bootstrapAdmin().then(() => server.listen(PORT, () => console.log(`Backroom Hold'em is running on port ${PORT}, saving data in ${DATA_DIR}`)))
  .catch(e => { console.error('Could not create the admin account:', e.message); process.exit(1); });
