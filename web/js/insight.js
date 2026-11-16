// Plain-language summaries and extra statistics, worked out from files the pipeline
// already publishes. These only count, average and describe; they decide nothing.
// No page dependencies, so they run under Node for tests.

const fin = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ------------------------------------------------------- whole-market view
// rows: market.heatmap = [{symbol, close, change_pct, health, call, atr_pct, p_up}]
export function marketStats(rows) {
  const list = (rows || []).filter((r) => r && r.symbol);
  const moved = list.filter((r) => fin(r.change_pct));
  const by = moved.slice().sort((a, b) => b.change_pct - a.change_pct);
  const ups = moved.filter((r) => r.change_pct > 0).length, downs = moved.filter((r) => r.change_pct < 0).length;
  const pUps = list.map((r) => r.p_up).filter(fin);
  const calls = { FAVOURABLE: 0, NEUTRAL: 0, NO_TRADE: 0 };
  for (const r of list) if (r.call in calls) calls[r.call] += 1;
  const mood = !moved.length ? "unknown" : ups >= moved.length * 0.65 ? "broadly up" : downs >= moved.length * 0.65 ? "broadly down" : "mixed";
  return {
    count: list.length, advancers: ups, decliners: downs, unchanged: moved.length - ups - downs, mood,
    avgChange: mean(moved.map((r) => r.change_pct)), medianChange: median(moved.map((r) => r.change_pct)),
    gainers: by.slice(0, 5).filter((r) => r.change_pct > 0), losers: by.slice(-5).reverse().filter((r) => r.change_pct < 0),
    biggestMove: moved.length ? Math.max(...moved.map((r) => Math.abs(r.change_pct))) : null,
    avgAtr: mean(list.map((r) => r.atr_pct).filter(fin)),
    avgPUp: mean(pUps), leanUp: pUps.filter((p) => p > 0.5).length, leanDown: pUps.filter((p) => p < 0.5).length,
    avgHealth: mean(list.map((r) => r.health).filter(fin)),
    calls, withPlan: calls.FAVOURABLE + calls.NEUTRAL,
  };
}

// ------------------------------------------------------- one stock, in words
const VERDICTS = {
  NO_TRADE: { tone: "idle", headline: "Nothing to do with this stock today.",
    text: "The tool tried three simple buying rules on this stock's history. After paying normal trading costs, none of them made money. So the sensible move is to do nothing, which is the answer on most days." },
  NEUTRAL: { tone: "maybe", headline: "A weak maybe: worth watching, not acting on.",
    text: "One rule has a slightly positive record on this stock, but the evidence is thin and could be luck. The levels on the right show what that rule would do, as a what-if." },
  FAVOURABLE: { tone: "good", headline: "The strongest signal this tool gives. It is still not a promise.",
    text: "One rule has a positive record on this stock that is unlikely to be luck alone. Past results do not guarantee the next one, and any trade can lose." },
};
const lean = (p) => (p >= 0.55 ? "leans up" : p <= 0.45 ? "leans down" : "close to a coin flip");
const healthWord = (v) => (v >= 70 ? "strong" : v >= 45 ? "middling" : "weak");
const volumeWord = (v) => (v >= 1.5 ? "much busier than usual" : v >= 1.1 ? "busier than usual" : v <= 0.7 ? "quieter than usual" : "about normal");

// d: a symbol file. Returns {tone, headline, text, facts:[{key,label,value,note,dir}]} with numbers left unformatted
// (value is {kind, ...}) so the page formats them the same way as everything else.
export function plainWords(d) {
  const call = (d && d.call && d.call.call) || "NO_TRADE";
  const v = VERDICTS[call] || VERDICTS.NO_TRADE;
  const facts = [];
  const last = (d && d.last) || {};
  if (fin(last.close)) facts.push({ key: "close", label: "Last closing price", value: { kind: "px", x: last.close },
    note: fin(last.change_pct) ? { kind: "pct", x: last.change_pct, suffix: " on the day" } : null, dir: last.change_pct });
  if (fin(d && d.atr_pct)) facts.push({ key: "swing", label: "A normal day's swing", value: { kind: "plusminus", x: d.atr_pct },
    note: fin(d.atr) ? { kind: "text", text: `about ₹${d.atr.toFixed(2)} a share up or down` } : null });
  const c = d && d.claims;
  if (c && c.dir && fin(c.dir.p_up)) facts.push({ key: "up", label: "Chance it closes higher next session", value: { kind: "prob", x: c.dir.p_up },
    note: { kind: "text", text: lean(c.dir.p_up) } });
  if (c && c.close && fin(c.close.p05) && fin(c.close.p95) && fin(last.close)) facts.push({ key: "range", label: "Where it will most likely close",
    value: { kind: "range", lo: last.close * (1 + c.close.p05 / 100), hi: last.close * (1 + c.close.p95 / 100) },
    note: { kind: "text", text: "9 days out of 10, on days like this" } });
  if (c && c.range && fin(c.range.p50)) facts.push({ key: "hilo", label: "Typical gap between the day's high and low", value: { kind: "pct0", x: c.range.p50 },
    note: fin(c.range.p90) ? { kind: "text", text: `rarely more than ${c.range.p90.toFixed(1)}%` } : null });
  if (fin(last.volume_ratio)) facts.push({ key: "volume", label: "Trading activity", value: { kind: "times", x: last.volume_ratio },
    note: { kind: "text", text: volumeWord(last.volume_ratio) } });
  if (d && d.health && fin(d.health.score)) facts.push({ key: "health", label: "Trend health", value: { kind: "score", x: d.health.score },
    note: { kind: "text", text: `${healthWord(d.health.score)}; describes the past, does not predict` } });
  if (d && d.forecast && fin(d.forecast.n)) facts.push({ key: "similar", label: "Similar past days studied", value: { kind: "int", x: d.forecast.n },
    note: { kind: "text", text: "the more, the steadier the estimate" } });
  return { call, tone: v.tone, headline: v.headline, text: v.text, facts };
}

// ------------------------------------------------- the three rules side by side
export function ruleTable(d) {
  const out = [];
  for (const [kind, card] of Object.entries((d && d.plans) || {})) {
    const r = ((d.rules || {})[kind]) || {}, lv = (card && card.levels) || {};
    const o = r.outcomes || {}, n = r.trades || 0;
    out.push({
      kind, trades: n, winRate: fin(r.win_rate) ? r.win_rate : null, expectancyR: fin(r.expectancy_r) ? r.expectancy_r : null,
      pTrigger: fin(lv.p_trigger) ? lv.p_trigger : null, profitFactor: fin(r.profit_factor) ? r.profit_factor : null,
      losingStreak: fin(r.longest_losing_streak) ? r.longest_losing_streak : null,
      stoppedShare: n && fin(o.stopped) ? o.stopped / n : null,
      targetShare: n ? ((o.t1 || 0) + (o.t2 || 0)) / n : null,
      called: !!(d.call && d.call.call !== "NO_TRADE" && d.call.kind === kind),
    });
  }
  return out;
}

// ----------------------------------------------- summary of a "Make a plan" result
export function planStats(plans) {
  const list = (plans || []).filter((p) => p && p.shares > 0);
  if (!list.length) return null;
  const chances = list.map((p) => p.pTarget ?? p.pBest).filter(fin);
  const ratios = list.filter((p) => p.lossAtStop > 0).map((p) => p.bestGain / p.lossAtStop);
  return {
    count: list.length,
    bestChance: chances.length ? Math.max(...chances) : null,
    biggestGain: Math.max(...list.map((p) => p.bestGain)),
    smallestLoss: Math.min(...list.map((p) => p.lossAtStop)),
    avgPosition: mean(list.map((p) => p.value)),
    avgRewardRisk: mean(ratios),
    avgTrigger: mean(list.map((p) => p.pTrigger).filter(fin)),
    expectedTotal: mean(list.map((p) => p.expectedRs).filter(fin)),
  };
}
