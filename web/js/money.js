// Money arithmetic with no page dependencies, so it can be tested outside a browser.

// Costs: the same intraday charge formula as the pipeline (config/costs.yaml),
// re-applied here only to rescale figures for the capital the viewer types in.
export function charges(buy, sell, c) {
  const b = c.brokerage;
  const brokerage = Math.min(b.max_per_order, b.pct_per_order * buy) + Math.min(b.max_per_order, b.pct_per_order * sell);
  const turnover = buy + sell;
  const parts = { brokerage, stt: c.stt_sell * sell, exchange: c.exchange_txn * turnover, sebi: c.sebi_fee * turnover, stamp: c.stamp_duty_buy * buy };
  parts.gst = c.gst * (parts.brokerage + parts.exchange + parts.sebi);
  parts.total = Object.values(parts).reduce((a, v) => a + v, 0);
  return parts;
}
// Per-share prices of one plan, with exactly the pipeline's fill rules (pipeline/plans.py
// resolve_one), assuming the price reaches the entry level:
//   breakout (stop-buy) and the gap-down rule (market at the open) pay slippage on entry;
//   the dip buy is a limit order and pays none; stop exits pay slippage x the multiplier;
//   the best case sells half at each target (the gap-down rule has one target).
export function tradePrices(kind, L, slip, ccfg) {
  const s = Number.isFinite(slip) ? slip : 0;
  const mult = ccfg && ccfg.slippage && Number.isFinite(ccfg.slippage.stop_exit_multiplier) ? ccfg.slippage.stop_exit_multiplier : 1;
  const risk = Number.isFinite(L.risk) && L.risk > 0 ? L.risk : Number.isFinite(L.stop_distance) && L.stop_distance > 0 ? L.stop_distance : L.entry - L.stop;
  const fill = kind === "pullback" ? L.entry : L.entry * (1 + s);
  const stopLevel = kind === "gap_reversal" ? fill - risk : L.stop;      // the gap rule's stop follows the fill
  const t2 = Number.isFinite(L.t2) ? L.t2 : L.t1;
  return { fill, stopExit: stopLevel * (1 - s * mult), bestExit: 0.5 * L.t1 + 0.5 * t2, risk };
}

// Rupee best and worst case for `shares` of one plan, after charges.
export function tradeMoney(prices, shares, ccfg) {
  if (!(shares > 0)) return { best: 0, worst: 0, invested: 0 };
  const buy = shares * prices.fill;
  return {
    invested: buy,
    best: shares * (prices.bestExit - prices.fill) - charges(buy, shares * prices.bestExit, ccfg).total,
    worst: shares * (prices.stopExit - prices.fill) - charges(buy, shares * prices.stopExit, ccfg).total,
  };
}

export function position(entry, stop, capital, riskPct) {
  const riskPs = entry - stop;
  if (!(riskPs > 0) || !(entry > 0) || !(capital > 0)) return { shares: 0, value: 0, riskRs: 0, capped: false };
  const byRisk = Math.floor((capital * riskPct / 100) / riskPs), byCash = Math.floor(capital / entry);
  const shares = Math.max(0, Math.min(byRisk, byCash));
  return { shares, value: shares * entry, riskRs: shares * riskPs, capped: byCash < byRisk };
}
