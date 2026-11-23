'use strict';
/*
 * Blackjack engine. 6-deck shoe, dealer stands on soft 17 and peeks for blackjack,
 * blackjack pays 3:2, insurance pays 2:1, double on any two cards (also after a split),
 * split up to 4 hands, split aces get one card each. Amounts are integers in cents.
 * P is one player's saved record: { shoe, hand, n, lastBet }.
 */
const crypto = require('crypto');
const DECKS = 6;

function newShoe() {
  const c = [];
  for (let d = 0; d < DECKS; d++) for (let i = 0; i < 52; i++) c.push(i);
  for (let i = c.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = c[i]; c[i] = c[j]; c[j] = t; }
  return { cards: c, pos: 0, cut: Math.floor(c.length * 0.75) }; // reshuffle after 3/4 of the shoe
}
const rank = c => (c % 13) + 2;
const cardVal = c => { const r = rank(c); return r === 14 ? 11 : r >= 10 ? 10 : r; };
function total(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { if (c < 0) continue; t += cardVal(c); if (rank(c) === 14) aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return { t, soft: aces > 0 && t <= 21 };
}
const isBJ = h => h.cards.length === 2 && !h.split && total(h.cards).t === 21;

const BJ = {
  total, isBJ,
  draw(P) { if (P.shoe.pos >= P.shoe.cards.length) P.shoe = newShoe(); return P.shoe.cards[P.shoe.pos++]; },

  deal(P, bet) {
    let shuffled = false;
    if (!P.shoe || P.shoe.pos >= P.shoe.cut) { P.shoe = newShoe(); shuffled = true; }
    P.n = (P.n || 0) + 1;
    const H = { id: P.n, bet, dealer: [], hands: [{ cards: [], bet, done: false, split: false, aces: false, dbl: false, res: '', pay: 0 }],
      active: 0, phase: 'player', ins: 0, staked: bet, payout: 0, shuffled };
    const p = H.hands[0];
    p.cards.push(BJ.draw(P)); H.dealer.push(BJ.draw(P)); p.cards.push(BJ.draw(P)); H.dealer.push(BJ.draw(P));
    P.hand = H;
    if (rank(H.dealer[0]) === 14) { H.phase = 'insurance'; return H; }
    BJ.peek(P);
    return H;
  },
  // Dealer checks for blackjack; a natural on either side ends the hand at once.
  peek(P) {
    const H = P.hand;
    if (total(H.dealer).t === 21 || isBJ(H.hands[0])) { H.hands[0].done = true; return BJ.settle(P); }
    H.phase = 'player';
  },
  insurance(P, take) {
    const H = P.hand;
    H.ins = take ? Math.floor(H.bet / 2) : 0;
    H.staked += H.ins;
    BJ.peek(P);
  },
  cur: H => H.hands[H.active],
  canDouble(H) { const h = BJ.cur(H); return H.phase === 'player' && !!h && h.cards.length === 2 && !h.aces && !h.done; },
  canSplit(H) {
    const h = BJ.cur(H);
    return H.phase === 'player' && !!h && !h.done && h.cards.length === 2 && cardVal(h.cards[0]) === cardVal(h.cards[1]) && H.hands.length < 4 && !h.aces;
  },
  hit(P) {
    const H = P.hand, h = BJ.cur(H);
    h.cards.push(BJ.draw(P));
    if (total(h.cards).t >= 21) { h.done = true; BJ.next(P); }
  },
  stand(P) { BJ.cur(P.hand).done = true; BJ.next(P); },
  double(P) {
    const H = P.hand, h = BJ.cur(H);
    H.staked += h.bet; h.bet *= 2; h.dbl = true;
    h.cards.push(BJ.draw(P)); h.done = true;
    BJ.next(P);
  },
  split(P) {
    const H = P.hand, h = BJ.cur(H);
    const aces = rank(h.cards[0]) === 14;
    const nh = { cards: [h.cards.pop()], bet: h.bet, done: false, split: true, aces, dbl: false, res: '', pay: 0 };
    h.split = true; h.aces = aces;
    H.staked += h.bet;
    H.hands.splice(H.active + 1, 0, nh);
    h.cards.push(BJ.draw(P)); nh.cards.push(BJ.draw(P));
    if (aces) { h.done = true; nh.done = true; }
    else if (total(h.cards).t === 21) h.done = true;
    BJ.next(P);
  },
  next(P) {
    const H = P.hand;
    const i = H.hands.findIndex(h => !h.done);
    if (i >= 0) {
      H.active = i;
      if (total(H.hands[i].cards).t >= 21) { H.hands[i].done = true; return BJ.next(P); }
      return;
    }
    // Dealer draws only if at least one hand is still alive.
    if (H.hands.some(h => total(h.cards).t <= 21)) while (total(H.dealer).t < 17) H.dealer.push(BJ.draw(P));
    BJ.settle(P);
  },
  settle(P) {
    const H = P.hand, d = total(H.dealer).t, dBJ = H.dealer.length === 2 && d === 21;
    let pay = 0;
    if (H.ins && dBJ) pay += H.ins * 3;
    for (const h of H.hands) {
      const t = total(h.cards).t, bj = isBJ(h);
      if (bj && !dBJ) { h.res = 'bj'; h.pay = h.bet + Math.floor(h.bet * 3 / 2); }
      else if (dBJ) { h.res = bj ? 'push' : 'lose'; h.pay = bj ? h.bet : 0; }
      else if (t > 21) { h.res = 'bust'; h.pay = 0; }
      else if (d > 21 || t > d) { h.res = 'win'; h.pay = h.bet * 2; }
      else if (t === d) { h.res = 'push'; h.pay = h.bet; }
      else { h.res = 'lose'; h.pay = 0; }
      pay += h.pay;
    }
    H.payout = pay; H.phase = 'done'; H.dealerBJ = dBJ;
  }
};

module.exports = { BJ, newShoe };
