// pump-sharpe-sprint-01 — a paper-trading bot for the agent-fun/replay/v2 wire.
//
// The harness sends one `hello`, then one `batch` per slot, then `done` on stdin;
// this bot writes exactly one reply per `batch` on stdout, echoing the batch's
// `seq`. The shim in ./vendor/makefun-bot.ts owns that wire; this file only
// holds the strategy, decided in onBatch from the state the shim keeps.
//
// Strategy, designed from first principles and measured against the kit's dev
// data ("genuine-interest sniper", one shot per coin):
//   * Most pump.fun coins bleed: chasing a rise after it has happened loses
//     on average at every horizon, and so does buying dips. The survivors
//     are the coins real people pile into in their first seconds — so the
//     bot enters only at a mint's 5th trade (chain_seq 5), and only when all
//     five first trades are buys from five different wallets (genuine
//     interest, not one wallet washing) and the curve already holds at
//     least 3 SOL of real reserves (a real stake, not dust). One shot per
//     coin; a coin that does not qualify never gets a second chance.
//   * The payoff is deliberately asymmetric: take-profit +20%, stop-loss -5%.
//     At those levels a ~31% win rate still clears the ~2.6% round-trip fee,
//     and the wide target lets the occasional moon pay for many small cuts.
//     Losers are cut fast, winners are banked, no single coin can dominate.
//   * Every buy is the same size (0.2 SOL, capped by the harness per-mint
//     size cap of 1% of real reserves and by free cash), at most 5 positions
//     are open at once, and a time stop (~12 minutes) frees a slot that
//     never resolved. Small, diversified, disciplined trades are what make an
//     hourly Sharpe ratio.
//   * Fully deterministic: every decision comes from the hello/batch state.
//     No clock, no environment, no Math.random; the seed is never needed
//     because no randomness is used at all.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning knobs
// All sizes in lamports; all moves in basis points (100 bps = 1%).

/** SOL spent per buy (0.2 SOL). Big enough that fees are a small fraction. */
const TRADE_LAMPORTS = 200_000_000n;
/** Smallest buy worth sending (0.03 SOL): the 3-SOL reserve filter's cap. */
const MIN_TRADE_LAMPORTS = 30_000_000n;
/** Never hold more than this many positions at once (also capped by hello). */
const MAX_POSITIONS_WANTED = 5;
/** Entry happens at this trade of a mint (chain_seq 0 is the CreateEvent). */
const ENTRY_CHAIN_SEQ = 5;
/** Entry needs this many distinct buyers among the mint's first trades. */
const MIN_DISTINCT_BUYERS = 5;
/** Entry needs real reserves of at least this (lamports) at decision time. */
const MIN_REAL_RESERVES_LAMPORTS = 3_000_000_000n;
/** Skip the entry when the price already ran this far past the 5th trade. */
const BURST_GUARD_BPS = 500; // +5% within the decision batch: do not chase it
/** Exit: bank the win at this gain over the effective entry price. */
const TAKE_PROFIT_BPS = 2000; // +20%
/** Exit: cut the loss at this fall under the effective entry price. */
const STOP_LOSS_BPS = -500; // -5%
/** Exit: close a position held longer than this many slots (~12 minutes). */
const HOLD_MAX_SLOTS = 1800;
/** Slippage allowed on fills, in bps (5%). */
const SLIPPAGE_BPS = 500;
/** Cap how many early-mint records we keep, so memory stays bounded. */
const MAX_EARLY_MINTS = 4000;

/** Scale for fixed-point prices: price = virtualQuote * SCALE / virtualToken. */
const SCALE = 1_000_000_000n;

// ---------------------------------------------------------------- per-position state

/** What we paid for a held position. */
interface Entry {
  /** Effective entry price (SOL spent incl. fees / tokens received), scaled. */
  entryPrice: bigint;
  /** Slot the buy filled. */
  entrySlot: number;
}

const entries = new Map<string, Entry>();

/** What a mint's first trades looked like, while it is still that young. */
interface EarlyMint {
  /** Distinct wallets that bought in the mint's first trades. */
  buyers: Set<string>;
  /** Scaled price at the entry trade (chain_seq 5); 0n until it arrives. */
  priceAtEntry: bigint;
  /** True once the entry trade has been seen. */
  seenEntryTrade: boolean;
}

const earlyMints = new Map<string, EarlyMint>();

/** Scaled price of a curve from its virtual reserves; 0n when unpriced. */
function priceOf(curve: Curve): bigint {
  if (curve.virtual_token_reserves <= 0n) return 0n;
  return (curve.virtual_quote_reserves * SCALE) / curve.virtual_token_reserves;
}

/** Scaled price straight from a trade event's virtual reserves. */
function priceOfEvent(virtualQuote: string, virtualToken: string): bigint {
  const q = BigInt(virtualQuote);
  const t = BigInt(virtualToken);
  if (q <= 0n || t <= 0n) return 0n;
  return (q * SCALE) / t;
}

/** Change from `ref` to `now`, in basis points, as a bigint (negative when down). */
function bpsChange(now: bigint, ref: bigint): bigint {
  if (ref <= 0n) return 0n;
  return ((now - ref) * 10_000n) / ref;
}

/** Drop the oldest early-mint records when the map grows past its cap. */
function pruneEarlyMints(): void {
  while (earlyMints.size > MAX_EARLY_MINTS) {
    const oldest = earlyMints.keys().next().value;
    if (oldest === undefined) break;
    earlyMints.delete(oldest);
  }
}

/**
 * Fold one batch's chain events into the early-mint records, and return the
 * mints whose entry trade (chain_seq 5) arrived in this batch.
 */
function findEntries(batch: Batch): string[] {
  const found: string[] = [];
  for (const e of batch.events) {
    if (e.event !== "TradeEvent") continue;
    if (e.chain_seq > ENTRY_CHAIN_SEQ) continue;
    let rec = earlyMints.get(e.mint);
    if (rec === undefined) {
      rec = { buyers: new Set<string>(), priceAtEntry: 0n, seenEntryTrade: false };
      earlyMints.set(e.mint, rec);
    }
    if (e.is_buy) rec.buyers.add(e.user);
    if (e.chain_seq === ENTRY_CHAIN_SEQ) {
      rec.priceAtEntry = priceOfEvent(e.virtual_quote_reserves, e.virtual_token_reserves);
      rec.seenEntryTrade = true;
      found.push(e.mint);
    }
  }
  pruneEarlyMints();
  return found;
}

// ---------------------------------------------------------------- fills

/** Fold a batch's fills into the entry book: record cost basis on filled buys. */
function applyFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status !== "filled") continue;
    if (f.side === "buy") {
      const tokens = BigInt(f.token_amount);
      const spent = BigInt(f.quote_lamports);
      if (tokens > 0n && spent > 0n) {
        const entryPrice = (spent * SCALE) / tokens;
        entries.set(f.mint, { entryPrice, entrySlot: f.slot });
        console.error(`fill buy ${f.mint.slice(0, 8)} ${spent} lamports -> ${tokens} tokens @ slot ${f.slot}`);
      }
    } else {
      entries.delete(f.mint);
      console.error(`fill sell ${f.mint.slice(0, 8)} ${f.quote_lamports} lamports @ slot ${f.slot}`);
    }
  }
  // Harness closes (complete/flatten/writeoff) arrive as fills too, but be safe:
  // any entry whose position is gone is not a position any more.
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) entries.delete(mint);
  }
}

/** True when an order for this mint and side is still waiting for its fill. */
function hasPending(state: BotState, mint: string, side: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

// ---------------------------------------------------------------- exits

/** Decide the sells for this batch: take-profit, stop-loss, or time stop. */
function decideExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
  for (const [mint, holding] of state.positions) {
    const entry = entries.get(mint);
    if (entry === undefined) continue; // cost basis unknown; wait for the fill record
    if (hasPending(state, mint, "sell")) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const now = priceOf(curve);
    if (now <= 0n) continue;

    const pnlBps = bpsChange(now, entry.entryPrice);
    const heldSlots = batch.slot - entry.entrySlot;

    let reason = "";
    if (pnlBps >= BigInt(TAKE_PROFIT_BPS)) reason = "take-profit";
    else if (pnlBps <= BigInt(STOP_LOSS_BPS)) reason = "stop-loss";
    else if (heldSlots >= HOLD_MAX_SLOTS) reason = "time-stop";

    if (reason !== "") {
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      console.error(`exit ${reason} ${mint.slice(0, 8)} pnl ${pnlBps} bps held ${heldSlots} slots`);
    }
  }
}

// ---------------------------------------------------------------- entries

/** Decide the buys for this batch from the mints whose entry trade arrived. */
function decideEntries(
  state: BotState,
  batch: Batch,
  entryMints: string[],
  orders: OrderInput[],
): void {
  const maxOpen = Math.min(state.hello.caps.max_open_positions, MAX_POSITIONS_WANTED);
  const freeSlots = maxOpen - state.committedPositionCount();
  if (freeSlots <= 0) return;
  const room = state.hello.caps.max_orders_per_batch - orders.length;
  if (room <= 0) return;

  const txFee = state.txFeeLamports();
  // Size each candidate by its harness cap, biggest first, so the limited
  // position slots carry the most capital; mint address breaks ties.
  const candidates: { mint: string; cap: bigint }[] = [];
  for (const mint of entryMints) {
    if (state.positions.has(mint)) continue;
    if (hasPending(state, mint, "buy")) continue;
    const rec = earlyMints.get(mint);
    if (rec === undefined || !rec.seenEntryTrade) continue;
    // Genuine interest: five different wallets bought the first five trades.
    if (rec.buyers.size < MIN_DISTINCT_BUYERS) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    // A real stake behind the coin: at least 3 SOL of real reserves.
    if (curve.real_quote_reserves < MIN_REAL_RESERVES_LAMPORTS) continue;
    // Burst guard: do not chase a coin that already ran past its entry price.
    const now = priceOf(curve);
    if (now <= 0n || rec.priceAtEntry <= 0n) continue;
    if (bpsChange(now, rec.priceAtEntry) > BigInt(BURST_GUARD_BPS)) continue;
    const cap = state.maxBuyLamports(mint);
    if (cap < MIN_TRADE_LAMPORTS) continue;
    candidates.push({ mint, cap });
  }
  candidates.sort((a, b) => {
    if (a.cap !== b.cap) return a.cap > b.cap ? -1 : 1;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });

  let cash = state.freeCashLamports();
  let sent = 0;
  for (const c of candidates) {
    if (sent >= freeSlots || sent >= room) break;
    let size = TRADE_LAMPORTS;
    if (size > c.cap) size = c.cap;
    if (size > cash - txFee) size = cash - txFee;
    if (size < MIN_TRADE_LAMPORTS) continue;
    orders.push({
      side: "buy",
      mint: c.mint,
      quote_lamports: size,
      max_slippage_bps: SLIPPAGE_BPS,
    });
    cash -= size + txFee;
    sent += 1;
    console.error(`enter ${c.mint.slice(0, 8)} size ${size} cap ${c.cap}`);
  }
  // Entry records are spent whether the mint was taken or not: a mint gets
  // exactly one shot, at its 5th trade.
  for (const mint of entryMints) earlyMints.delete(mint);
}

// ---------------------------------------------------------------- wire callbacks

let batchCount = 0;

/** One batch, one reply: fold the batch in, then decide this slot's orders. */
function onBatch(state: BotState, batch: Batch): OrderInput[] {
  batchCount += 1;
  applyFills(state, batch);
  const entryMints = findEntries(batch);
  const orders: OrderInput[] = [];
  decideExits(state, batch, orders);
  decideEntries(state, batch, entryMints, orders);
  if (batchCount % 5000 === 0) {
    console.error(
      `batch ${batch.seq} slot ${batch.slot} cash ${state.cash} ` +
        `positions ${state.positions.size} orders ${orders.length}`,
    );
  }
  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `hello seed=${state.hello.seed} capital=${state.hello.capital.lamports} ` +
        `maxOpen=${state.hello.caps.max_open_positions} ` +
        `maxOrderBps=${state.hello.caps.max_order_bps_of_real_reserve} ` +
        `maxOrdersPerBatch=${state.hello.caps.max_orders_per_batch} ` +
        `latencySlots=${state.hello.latency_slots} ` +
        `fees=${state.hello.fees.protocol_bps_fallback}+${state.hello.fees.creator_bps_fallback}bps ` +
        `txFee=${state.txFeeLamports()} lamports`,
    );
    console.error(`capital ${(LAMPORTS_PER_SOL / 1n).toString()} lamports = 1 SOL; trade size ${TRADE_LAMPORTS} lamports`);
  },
  onBatch,
  onDone(state, done) {
    console.error(
      `done reason=${done.reason} batches=${batchCount} ` +
        `cash=${state.cash} positions=${state.positions.size} ` +
        `entries tracked at end=${entries.size}`,
    );
  },
});
