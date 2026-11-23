'use strict';
/*
 * No-Limit Texas Hold'em engine. Pure game logic, no networking.
 * All chip amounts are integers in cents (1 chip = 100), so 0.25/0.5 blinds work exactly.
 */
const crypto = require('crypto');

const RANK_NM = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PL = ['', '', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const rankOf = c => (c % 13) + 2;
const suitOf = c => Math.floor(c / 13);
const money = c => (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

function shuffle() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = d[i]; d[i] = d[j]; d[j] = t; }
  return d;
}

function eval5(cs) {
  const r = cs.map(rankOf).sort((a, b) => b - a);
  const flush = cs.every(c => suitOf(c) === suitOf(cs[0]));
  let sHi = 0;
  if (new Set(r).size === 5) {
    if (r[0] - r[4] === 4) sHi = r[0];
    else if (r[0] === 14 && r[1] === 5 && r[4] === 2) sHi = 5;
  }
  const cnt = {};
  r.forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  const g = Object.keys(cnt).map(k => [+k, cnt[k]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let cat, tb;
  if (sHi && flush) { cat = 8; tb = [sHi]; }
  else if (g[0][1] === 4) { cat = 7; tb = [g[0][0], g[1][0]]; }
  else if (g[0][1] === 3 && g[1][1] === 2) { cat = 6; tb = [g[0][0], g[1][0]]; }
  else if (flush) { cat = 5; tb = r; }
  else if (sHi) { cat = 4; tb = [sHi]; }
  else if (g[0][1] === 3) { cat = 3; tb = g.map(x => x[0]); }
  else if (g[0][1] === 2 && g[1][1] === 2) { cat = 2; tb = g.map(x => x[0]); }
  else if (g[0][1] === 2) { cat = 1; tb = g.map(x => x[0]); }
  else { cat = 0; tb = r; }
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tb[i] || 0);
  return { score, cat, tb };
}
function evalBest(cards) {
  const n = cards.length;
  if (n < 5) return null;
  let best = null;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++)
    for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      const r = eval5(five);
      if (!best || r.score > best.score) { r.cards = five; best = r; }
    }
  return best;
}
function handName(e) {
  const t = e.tb;
  switch (e.cat) {
    case 8: return t[0] === 14 ? 'Royal flush' : `Straight flush, ${RANK_NM[t[0]]} high`;
    case 7: return `Four ${RANK_PL[t[0]]}`;
    case 6: return `${RANK_PL[t[0]]} full of ${RANK_PL[t[1]]}`;
    case 5: return `Flush, ${RANK_NM[t[0]]} high`;
    case 4: return `Straight, ${RANK_NM[t[0]]} high`;
    case 3: return `Three ${RANK_PL[t[0]]}`;
    case 2: return `Two pair, ${RANK_PL[t[0]]} and ${RANK_PL[t[1]]}`;
    case 1: return `Pair of ${RANK_PL[t[0]]}`;
    default: return `${RANK_NM[t[0]]} high`;
  }
}
function startingHandName(c) {
  const a = rankOf(c[0]), b = rankOf(c[1]), hi = Math.max(a, b), lo = Math.min(a, b);
  if (a === b) return `Pocket ${RANK_PL[a]}`;
  return `${RANK_NM[hi]}-${RANK_NM[lo]}${suitOf(c[0]) === suitOf(c[1]) ? ' suited' : ''}`;
}

function newState(cfg) {
  return {
    v: 1, cfg, seats: Array(cfg.size).fill(null),
    h: { id: 0, ph: 'wait', btn: -1, sbI: -1, bbI: -1, board: [], cur: 0, minR: cfg.bb, toAct: -1, dl: 0, next: 0, run: false, res: null, won: null, di: 0, rake: 0, pot: 0 },
    log: [], out: []
  };
}
// pid = user id; nick = name shown to other players; uname = real username
function newSeat(pid, nick, uname, stack) {
  return { pid, nick, uname, stack, buyin: stack, bet: 0, tot: 0, st: 'o', act: false, last: '', so: false, to: 0, c: null, lv: false, soAt: 0 };
}

const E = {
  inHand: s => !!s && (s.st === '' || s.st === 'a'),
  canAct: s => !!s && s.st === '',
  eligible: s => !!s && !s.so && !s.lv && s.stack > 0,
  live: S => S.h.ph !== 'wait' && S.h.ph !== 'show',
  next(S, from, pred) {
    const n = S.seats.length;
    for (let k = 1; k <= n; k++) { const i = ((from + k) % n + n) % n; if (pred(S.seats[i], i)) return i; }
    return -1;
  },
  log(S, msg) { S.log.push(msg); if (S.log.length > 40) S.log.splice(0, S.log.length - 40); },
  potTotal: S => S.seats.reduce((a, s) => a + (s ? s.tot : 0), 0),
  pay(s, x) {
    x = Math.max(0, Math.min(x, s.stack));
    s.stack -= x; s.bet += x; s.tot += x;
    if (s.stack === 0) s.st = 'a';
    return x;
  },
  payDead(s, x) { // antes: go in the pot but don't count toward the bet
    x = Math.max(0, Math.min(x, s.stack));
    s.stack -= x; s.tot += x;
    if (s.stack === 0) s.st = 'a';
    return x;
  },
  setClock(S, now) { S.h.dl = now + S.cfg.turn * 1000; },

  start(S, P, now) {
    const elig = [];
    S.seats.forEach((s, i) => { if (E.eligible(s)) elig.push(i); });
    if (elig.length < 2) return false;
    const h = S.h, cfg = S.cfg, n = S.seats.length;
    const isE = (s, i) => elig.includes(i);
    h.id += 1;
    h.btn = E.next(S, h.btn < 0 ? crypto.randomInt(n) : h.btn, isE);
    h.sbI = elig.length === 2 ? h.btn : E.next(S, h.btn, isE);
    h.bbI = E.next(S, h.sbI, isE);
    const deck = shuffle();
    P.hid = h.id; P.deck = deck; P.holes = {};
    h.di = 0;
    S.seats.forEach((s, i) => {
      if (!s) return;
      Object.assign(s, { bet: 0, tot: 0, act: false, last: '', c: null, st: elig.includes(i) ? '' : 'o' });
    });
    for (const i of elig) P.holes[i] = [deck[h.di++], deck[h.di++]];
    Object.assign(h, { board: [], res: null, won: null, run: false, next: 0, ph: 'pre', toAct: -1, rake: 0, pot: 0 });
    if (cfg.ante > 0) elig.forEach(i => E.payDead(S.seats[i], cfg.ante));
    E.pay(S.seats[h.sbI], cfg.sb);
    E.pay(S.seats[h.bbI], cfg.bb);
    h.cur = cfg.bb; h.minR = cfg.bb;
    E.log(S, `Hand #${h.id}: ${S.seats[h.btn].nick} has the button`);
    E.afterMove(S, P, h.bbI, now);
    return true;
  },

  needs(S) { const h = S.h; return s => E.canAct(s) && (!s.act || s.bet < h.cur); },

  afterMove(S, P, from, now) {
    const h = S.h;
    if (S.seats.filter(E.inHand).length === 1) return E.winByFold(S, P, now);
    const actors = S.seats.filter(E.canAct);
    const needs = E.needs(S);
    const done = actors.length === 0 || (actors.length === 1 && actors[0].bet >= h.cur) || !S.seats.some(needs);
    if (done) return E.endRound(S, P, now);
    const prev = h.toAct;
    h.toAct = E.next(S, from, needs);
    if (h.toAct !== prev) E.setClock(S, now);
  },

  endRound(S, P, now) {
    const h = S.h;
    S.seats.forEach(s => { if (s) { s.bet = 0; if (s.st === '') { s.act = false; s.last = ''; } } });
    h.cur = 0; h.minR = S.cfg.bb; h.toAct = -1;
    if (h.ph === 'river') return E.showdown(S, P, now);
    if (S.seats.filter(E.canAct).length <= 1) {
      S.seats.forEach((s, i) => { if (E.inHand(s)) s.c = P.holes[i]; });
      h.run = true; h.next = now + 1400;
      return;
    }
    E.deal(S, P);
    h.toAct = E.next(S, h.btn, E.canAct);
    E.setClock(S, now);
  },

  deal(S, P) {
    const h = S.h, d = P.deck;
    h.di++; // burn
    if (h.ph === 'pre') { h.board.push(d[h.di++], d[h.di++], d[h.di++]); h.ph = 'flop'; }
    else if (h.ph === 'flop') { h.board.push(d[h.di++]); h.ph = 'turn'; }
    else if (h.ph === 'turn') { h.board.push(d[h.di++]); h.ph = 'river'; }
  },

  act(S, P, i, a, amt, now, auto) {
    const h = S.h, s = S.seats[i];
    if (!s || h.toAct !== i || s.st !== '' || h.run || !E.live(S)) return false;
    const toCall = Math.max(0, h.cur - s.bet);
    if (a === 'k' && toCall > 0) return false;
    if (a === 'r') {
      const maxTo = s.bet + s.stack;
      if (s.act || maxTo <= h.cur) a = 'c';
      else {
        const minTo = Math.min(maxTo, h.cur + h.minR);
        const to = Math.max(minTo, Math.min(maxTo, Math.floor(+amt || 0)));
        const was = h.cur;
        E.pay(s, to - s.bet);
        const by = to - was;
        if (by >= h.minR) {
          h.minR = by;
          S.seats.forEach((o, j) => { if (j !== i && E.canAct(o)) o.act = false; });
        }
        h.cur = Math.max(h.cur, to);
        const allin = s.st === 'a';
        s.last = allin ? 'All-in' : (was === 0 ? `Bet ${money(to)}` : `Raise ${money(to)}`);
        E.log(S, allin ? `${s.nick} is all-in for ${money(to)}` : was === 0 ? `${s.nick} bets ${money(to)}` : `${s.nick} raises to ${money(to)}`);
      }
    }
    if (a === 'f') { s.st = 'f'; s.last = 'Fold'; E.log(S, `${s.nick} folds`); }
    else if (a === 'k') { s.last = 'Check'; E.log(S, `${s.nick} checks`); }
    else if (a === 'c') {
      if (toCall === 0) { s.last = 'Check'; E.log(S, `${s.nick} checks`); }
      else {
        const paid = E.pay(s, toCall);
        s.last = s.st === 'a' ? 'All-in' : `Call ${money(paid)}`;
        E.log(S, s.st === 'a' ? `${s.nick} calls all-in ${money(paid)}` : `${s.nick} calls ${money(paid)}`);
      }
    } else if (a !== 'r') return false;
    s.act = true;
    if (!auto) s.to = 0;
    E.afterMove(S, P, i, now);
    return true;
  },

  timeout(S, P, now) {
    const h = S.h, s = S.seats[h.toAct];
    s.to = (s.to || 0) + 1;
    E.act(S, P, h.toAct, h.cur - s.bet > 0 ? 'f' : 'k', 0, now, true);
    if (s.to >= 2 && !s.so) { s.so = true; s.soAt = now; E.log(S, `${s.nick} timed out and is sitting out`); }
  },

  foldOut(S, P, i, now) {
    const h = S.h, s = S.seats[i];
    if (!s || s.st !== '') return;
    const wasTurn = h.toAct === i;
    s.st = 'f'; s.last = 'Fold'; s.act = true;
    E.log(S, `${s.nick} folds`);
    if (S.seats.filter(E.inHand).length === 1) return E.winByFold(S, P, now);
    if (h.run || h.toAct < 0) return;
    E.afterMove(S, P, wasTurn ? i : (h.toAct - 1 + S.seats.length) % S.seats.length, now);
  },

  // Player leaves: cashes out now, or after the hand if they still have chips in it.
  leave(S, P, i, now) {
    const s = S.seats[i];
    if (!s) return;
    // Anyone with chips in this hand's pot (even after folding) stays until the hand ends.
    if (E.live(S) && (E.inHand(s) || s.tot > 0)) { s.lv = true; if (s.st === '') E.foldOut(S, P, i, now); }
    else { S.out.push({ pid: s.pid, stack: s.stack, seat: i }); S.seats[i] = null; }
  },

  pots(S, cont) {
    const tots = S.seats.map(s => (s ? s.tot : 0));
    const levels = [...new Set(tots.filter(t => t > 0))].sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const L of levels) {
      let amt = 0;
      tots.forEach(t => { amt += Math.min(t, L) - Math.min(t, prev); });
      const elig = cont.filter(i => tots[i] >= L);
      prev = L;
      if (!amt) continue;
      const last = out[out.length - 1];
      if (!elig.length) { if (last) last.amt += amt; else out.push({ amt, elig: cont.slice() }); continue; }
      if (last && last.elig.length === elig.length && last.elig.every((x, k) => x === elig[k])) last.amt += amt;
      else out.push({ amt, elig });
    }
    return out;
  },

  // The house fee: % of contested pots, capped. Taken from the main pot first.
  takeRake(S, pots) {
    const c = S.cfg;
    if (!c.fee || (c.nfnd && !S.h.board.length)) return 0;
    const contested = pots.filter(p => p.elig.length > 1);
    const base = contested.reduce((a, p) => a + p.amt, 0);
    let rake = Math.floor(base * c.fee / 100);
    if (c.cap > 0) rake = Math.min(rake, c.cap);
    let left = rake;
    for (const p of contested) { const x = Math.min(left, p.amt); p.amt -= x; left -= x; }
    return rake - left;
  },

  winByFold(S, P, now) {
    const h = S.h;
    const wi = S.seats.findIndex(E.inHand);
    const w = S.seats[wi], total = E.potTotal(S);
    const maxOther = Math.max(0, ...S.seats.map((s, i) => (s && i !== wi ? s.tot : 0)));
    const uncalled = Math.max(0, w.tot - maxOther);
    const pot = [{ amt: total - uncalled, elig: [wi, -1] }];
    const rake = pot[0].amt > 0 ? E.takeRake(S, pot) : 0;
    const win = total - rake;
    w.stack += win;
    h.res = [{ amt: win, w: [wi], name: '', best: null }];
    h.won = { [wi]: win }; h.rake = rake; h.pot = total;
    h.ph = 'show'; h.toAct = -1; h.run = false; h.next = now + 2800;
    E.log(S, `${w.nick} wins ${money(win)}${rake ? ` (fee ${money(rake)})` : ''}`);
    E.finish(S);
  },

  showdown(S, P, now) {
    const h = S.h;
    const cont = [];
    S.seats.forEach((s, i) => { if (E.inHand(s)) { cont.push(i); s.c = P.holes[i]; } });
    const ev = {};
    cont.forEach(i => { ev[i] = evalBest(P.holes[i].concat(h.board)); });
    const pots = E.pots(S, cont);
    const total = pots.reduce((a, p) => a + p.amt, 0);
    const rake = E.takeRake(S, pots);
    const res = [], won = {}, n = S.seats.length;
    for (const p of pots) {
      if (!p.amt) continue;
      let best = -1, ws = [];
      for (const i of p.elig) {
        const sc = ev[i].score;
        if (sc > best) { best = sc; ws = [i]; } else if (sc === best) ws.push(i);
      }
      ws.sort((a, b) => ((a - h.btn - 1 + n) % n) - ((b - h.btn - 1 + n) % n));
      const share = Math.floor(p.amt / ws.length);
      let rem = p.amt - share * ws.length;
      ws.forEach(i => { const x = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; S.seats[i].stack += x; won[i] = (won[i] || 0) + x; });
      const contested = p.elig.length > 1;
      res.push({ amt: p.amt, w: ws, name: contested ? handName(ev[ws[0]]) : '', best: contested ? ev[ws[0]].cards : null });
      const names = ws.map(i => S.seats[i].nick).join(' & ');
      E.log(S, contested ? `${names} ${ws.length > 1 ? 'split' : 'wins'} ${money(p.amt)} with ${handName(ev[ws[0]])}` : `${names} takes back ${money(p.amt)}`);
    }
    if (rake) E.log(S, `Fee: ${money(rake)}`);
    Object.assign(h, { res, won, rake, pot: total, ph: 'show', toAct: -1, run: false, next: now + 6000 });
    E.finish(S);
  },

  finish(S) { S.seats.forEach(s => { if (s) { s.bet = 0; s.tot = 0; s.act = false; } }); },

  cleanup(S) {
    S.seats.forEach((s, i) => {
      if (!s) return;
      if (s.lv) { S.out.push({ pid: s.pid, stack: s.stack, seat: i }); S.seats[i] = null; return; }
      Object.assign(s, { st: 'o', c: null, last: '', bet: 0, tot: 0, act: false });
    });
    Object.assign(S.h, { res: null, won: null, board: [], ph: 'wait', toAct: -1, run: false, next: 0 });
  },

  // Cancel the hand in progress and give every player back what they put in.
  voidHand(S, why) {
    S.seats.forEach(s => { if (s) { s.stack += s.tot; Object.assign(s, { bet: 0, tot: 0, st: 'o', c: null, last: '', act: false }); } });
    S.seats.forEach((s, i) => { if (s && s.lv) { S.out.push({ pid: s.pid, stack: s.stack, seat: i }); S.seats[i] = null; } });
    Object.assign(S.h, { ph: 'wait', toAct: -1, run: false, res: null, won: null, board: [], next: 0, cur: 0 });
    E.log(S, why || 'Hand cancelled. Bets were returned.');
  },

  // Advance timers. beforeStart(S) may return false to stop a new hand from starting.
  tick(S, P, now, beforeStart) {
    const h = S.h;
    if (h.ph === 'show') {
      if (now < h.next) return false;
      E.cleanup(S);
      if (beforeStart && beforeStart(S) === false) return true;
      if (!E.start(S, P, now)) h.next = 0;
      return true;
    }
    if (h.ph === 'wait') {
      const n = S.seats.filter(E.eligible).length;
      if (n < 2) { if (h.next) { h.next = 0; return true; } return false; }
      if (!h.next) { h.next = now + 2500; return true; }
      if (now < h.next) return false;
      if (beforeStart && beforeStart(S) === false) { h.next = 0; return true; }
      if (!E.start(S, P, now)) h.next = 0;
      return true;
    }
    if (h.run) {
      if (now < h.next) return false;
      if (h.ph === 'river') E.showdown(S, P, now);
      else { E.deal(S, P); h.next = now + 1400; }
      return true;
    }
    if (h.toAct < 0) return false;
    const s = S.seats[h.toAct];
    if (!s || s.st !== '') { E.afterMove(S, P, h.toAct, now); return true; }
    if (now >= h.dl) { E.timeout(S, P, now); return true; }
    return false;
  }
};

module.exports = { E, newState, newSeat, evalBest, handName, startingHandName, money, rankOf, suitOf };
