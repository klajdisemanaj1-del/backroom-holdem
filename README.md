# Backroom Hold'em

A private No-Limit Texas Hold'em club. The server is the dealer: it shuffles, deals and runs every table on its own, so games keep going with nobody's phone acting as host. Each player only ever receives their own cards. The admin doesn't see any cards either, until showdown.

## What's inside

- **No-Limit Hold'em cash tables**, 2 to 9 seats, with blinds, antes, side pots, split pots, a turn timer and auto sit-out.
- **Accounts made by the admin.** Players log in with the username and password you give them, and they can change their password later.
- **Cashier.** You transfer chips to a player's balance and withdraw them back. Every movement is logged: transfers, withdrawals, buy-ins and cash-outs.
- **House fee.** The dealer takes a share of every pot (default 5%, capped at 3 big blinds). Each hand's fee is recorded in the Fees tab.
- **Books check.** The overview confirms that chips issued = player balances + chips on tables + fees.
- **Table settings** (defaults match your PokerBros screenshot):
  - Table Size 9 max, Action Time 25 sec, Blinds 0.25/0.5
  - Buy-in 10–125, Ante 0.5 BB, Fee 5%, Fee Cap 3 × BB, Game Length 12 hours
  - Anonymous Table, No Rathole and Buy-in Authorization are on
  - No Flop No Fee is an optional switch, off by default, so every hand pays the fee
- Tables have no name and no code. They appear in the lobby as "NLH 0.25/0.50 · 9-max".

## Run it on a computer

You need Node.js 18 or newer. There are no packages to install.

```
node server.js
```

Open http://localhost:3000. The first visit asks you to create the admin account.

## Put it online

Any service that runs a Node.js app works, for example Render, Railway, Fly.io or a small VPS.

1. Upload this folder, or connect it from a GitHub repository.
2. Set the start command to `node server.js`.
3. Set these environment variables:
   - `ADMIN_USERNAME` and `ADMIN_PASSWORD`: your admin login, created on first start. Set these so nobody else can claim the admin account before you do.
   - `DATA_DIR`: a folder on a **persistent disk or volume**. On Railway you can skip this: attach a volume and the server finds it automatically. All players, balances and history live in `DATA_DIR/db.json`. If the disk isn't persistent, everything resets when the app restarts.
   - `TZ` (optional): time zone for the daily fee report. The default is `Europe/Tirane`.
   - `PORT` is usually set by the host automatically.
4. Make sure the site is served over **https**. Most hosts do this automatically.

Back up `db.json` now and then.

## How to use it

1. Log in as admin. In **Players**, create an account for each friend, with a starting balance if you like.
2. In **Tables**, start a table. The settings are already filled in.
3. Friends log in, tap the table and pick a seat. With Buy-in Authorization on, their request appears in **Overview** for you to approve.
4. Use a player's card in **Players** to transfer or withdraw chips, reset their password or disable the account.
5. **Fees** shows today's fees, the last 14 days and the fee from each hand.

When a table's game length runs out, it finishes the current hand, closes, and returns everyone's chips to their balances.

The admin account doesn't play. To play yourself, create a separate player account.

## Security notes

- Passwords are hashed with scrypt. Five wrong passwords lock a username for 10 minutes.
- Sessions use HttpOnly, SameSite=Strict cookies. Requests from other sites are blocked.
- Hole cards are kept only in server memory. If the server restarts mid-hand, that hand is cancelled and bets are returned.
