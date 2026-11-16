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
export function position(entry, stop, capital, riskPct) {
  const riskPs = entry - stop;
  if (!(riskPs > 0) || !(entry > 0) || !(capital > 0)) return { shares: 0, value: 0, riskRs: 0, capped: false };
  const byRisk = Math.floor((capital * riskPct / 100) / riskPs), byCash = Math.floor(capital / entry);
  const shares = Math.max(0, Math.min(byRisk, byCash));
  return { shares, value: shares * entry, riskRs: shares * riskPs, capped: byCash < byRisk };
}
