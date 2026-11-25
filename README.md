# pump-sharpe-sprint-01

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/JoySakral/pump-sharpe-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/JoySakral/pump-sharpe-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the Pump.fun Sharpe Sprint: it trades paper SOL on a
6-hour pump.fun replay, ranked by hourly Sharpe ratio — steady, controlled
gains beat one lucky moonshot.

## How it works

The bot speaks the `agent-fun/replay/v2` protocol over stdin/stdout (the
`vendor/makefun-bot.ts` shim owns the wire; `main.ts` holds the strategy).
Every batch it:

1. watches each mint's first trades, and buys a mint once — at its 5th
   trade — only when all five first trades are buys from five different
   wallets and the curve already holds at least 3 SOL of real reserves;
2. exits positions on a take-profit (+20%), a tight stop-loss (−5%), or a
   time stop (~12 minutes).

Every buy is the same size (0.2 SOL, capped by the harness per-mint size cap
and by free cash), at most 5 positions are open at once, and the bot is fully
deterministic: no clock, no environment, no randomness.

## Run

```sh
node main.ts
```

The harness feeds it `hello`, then one `batch` per slot, then `done` on stdin;
the bot writes exactly one reply per batch on stdout.

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
