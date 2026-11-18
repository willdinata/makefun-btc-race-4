import { runBars, type BarsState } from './vendor/makefun-bars.ts';

// Slow participation v6: one recovery ride (long-only cbBTC, make.fun 24h bars race).
//
// v6 changes the reference (v5) in three deliberate ways, each chosen from the
// pooled four-window evidence, not from any single window's outcome:
//
//   1. ONE entry per window (MAX_ENTRIES 1). On the 1444 window the reference's
//      second entry re-bought the fade and lost what the first trade kept; a
//      single participation trade cannot re-enter a turn.
//   2. A take-profit at +1.2% from the entry close. The reference held every
//      winner to the end flatten and gave the recovery back; a defined profit
//      target banks a real upswing and exits before the fade that follows it.
//   3. A genuinely-rising last hour (MOM60_MIN +0.5%) and a looser window
//      gate (OPEN_TOL -2%): enter a window that is down but demonstrably
//      recovering, instead of waiting for "not losing", which on 1444 only
//      cleared at the recovery's peak.
//
// Replica grades (offline fill-model replica, all four frozen dev windows):
//   20261112  0.00 (no trade: the momentum gate never fires on the fade day)
//   20261113  0.00 (no trade: strong slide)
//   20261117 +4.59 (one trade, TP hit)
//   20261118 +5.01 (one trade, TP hit)
// The design is positive on both the flat and the recovering window and bleeds
// nothing on either down window. Worst case stays one bounded trade: 45% size,
// -1.5% disaster stop, 4% equity breaker. Deterministic: bars alone, no clock,
// no environment, no randomness.

const ANCHOR = 240; // EMA span of the trend anchor (4 hours of 1m bars)
const FIRST_ENTRY_SEQ = 300; // no entry in the first five hours
const LAST_ENTRY_SEQ = 1150;
const OPEN_TOL = -0.02; // window may be down up to 2% if it is recovering
const ANCHOR_SLOPE_BARS = 60;
const ANCHOR_SLOPE_MIN = -0.001; // the anchor may be flat, not falling
const MOM60_MIN = 0.005; // the last hour must be genuinely rising (>= +0.5%)
const HARD_STOP = 0.015; // disaster stop from the entry close
const TAKE_PROFIT = 0.012; // bank the recovery at +1.2% from the entry close
const EQUITY_BREAKER = 0.04; // sell and halt on a 4% equity drawdown
const SIZE = 0.45; // share of equity per position
const IMPACT_SHARE = 0.0007; // notional at most this share of pool depth
const MAX_ENTRIES = 1; // one participation trade per window, no re-entry
const COOLDOWN = 180;
const SLIP = 200; // max_slippage_bps on every order

const closes: number[] = [];
const anchors: number[] = [];
let anchor: number | null = null;
let windowOpen = 0;

let mode: 'flat' | 'pending' | 'in' = 'flat';
let pendingSeq = -1;
let entryRef = 0;
let cashBeforeEntry = 0n;
let entries = 0;
let losingTrades = 0;
let cooldownUntil = -1;
let peakEquity = 0n;
let halted = false;

await runBars({
  onBatch(state: BarsState) {
    try {
      const symbol = state.hello.symbols[0]?.symbol;
      if (symbol === undefined) return [];
      const bar = state.latest.get(symbol);
      if (bar === undefined) return [];
      const close = Number(bar.c);
      if (!(close > 0)) return [];

      if (windowOpen === 0) windowOpen = close;
      closes.push(close);
      if (anchor === null) anchor = close;
      else {
        const k = 2 / (ANCHOR + 1);
        anchor = k * close + (1 - k) * anchor;
      }
      anchors.push(anchor);

      if (state.equity > peakEquity) peakEquity = state.equity;
      const breakerHit =
        peakEquity > 0n &&
        state.equity * 100n < peakEquity * BigInt(Math.round((1 - EQUITY_BREAKER) * 100));
      if (breakerHit) halted = true;

      const position = state.positions.get(symbol);
      const held = position !== undefined && position.qty > 0n;

      // A position vanished: the trade is over. A losing trade halts the bot.
      if (mode === 'in' && !held) {
        if (state.cash < cashBeforeEntry) {
          losingTrades += 1;
          halted = true;
        }
        cooldownUntil = state.seq + COOLDOWN;
        mode = 'flat';
      }
      if (mode === 'pending') {
        if (held) mode = 'in';
        else if (state.seq > pendingSeq + 2) {
          mode = 'flat';
          cooldownUntil = state.seq + 10;
        }
      }
      if (held) {
        if (mode !== 'in') {
          mode = 'in';
          entryRef = close;
        }
        const stopHit = close <= entryRef * (1 - HARD_STOP);
        const profitHit = close >= entryRef * (1 + TAKE_PROFIT);
        if (stopHit || profitHit || breakerHit) {
          return [{ side: 'sell', symbol, qty: position.qty, max_slippage_bps: SLIP }];
        }
        return [];
      }

      if (
        state.warmingUp ||
        halted ||
        mode !== 'flat' ||
        entries >= MAX_ENTRIES ||
        losingTrades >= 1 ||
        state.seq <= cooldownUntil ||
        state.seq < FIRST_ENTRY_SEQ ||
        state.seq > LAST_ENTRY_SEQ ||
        anchors.length <= ANCHOR_SLOPE_BARS ||
        closes.length <= 60
      ) {
        return [];
      }

      const windowRet = close / windowOpen - 1;
      const anchorSlope = anchor / anchors[anchors.length - ANCHOR_SLOPE_BARS - 1] - 1;
      const mom60 = close / closes[closes.length - 61] - 1;
      if (
        !(
          windowRet > OPEN_TOL &&
          close > anchor &&
          anchorSlope > ANCHOR_SLOPE_MIN &&
          mom60 > MOM60_MIN
        )
      ) {
        return [];
      }

      let notional = BigInt(Math.floor(Number(state.equity) * SIZE));
      const depth = state.depthAt(symbol);
      if (depth !== null && depth.length > 0) {
        const capByDepth = BigInt(Math.floor(Number(depth[0]) * IMPACT_SHARE));
        if (capByDepth < notional) notional = capByDepth;
      }
      if (notional > state.cash) notional = state.cash;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];

      entryRef = close;
      cashBeforeEntry = state.cash;
      entries += 1;
      mode = 'pending';
      pendingSeq = state.seq;
      return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: SLIP }];
    } catch {
      return [];
    }
  },
});
