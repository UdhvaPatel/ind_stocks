// Home page arithmetic: the next plan in plain money, yesterday's result, and the recent
// record of one stock. Only reads published files (symbol file, compare.json); decides
// nothing new. No page dependencies, so it runs under Node for tests.
import { charges } from "./money.js";

const fin = (x) => typeof x === "number" && Number.isFinite(x);
export const RULE_KEYS = ["breakout", "pullback", "gap_reversal"];
export const RULE_TITLES = { breakout: "Buy on a rise", pullback: "Buy on a dip", gap_reversal: "Buy a low opening" };
export const AMOUNTS = [10000, 50000, 100000];

export const VERDICTS = {
  NO_TRADE: { tone: "wait", badge: "Wait", title: "No clear chance. Waiting is the smart move.",
    text: "None of the tested buying plans has made money on this stock after trading costs. The plan below is shown so you can learn from it, not as a suggestion to buy." },
  NEUTRAL: { tone: "maybe", badge: "Maybe", title: "A small chance, with weak evidence.",
    text: "One plan has a slightly positive past record here, but it could be luck. Treat it as something to watch." },
  FAVOURABLE: { tone: "good", badge: "Good setup", title: "The strongest signal this site gives.",
    text: "One plan has a positive past record here that is unlikely to be luck alone. It can still lose; nothing here is a promise." },
};

// Rupees for putting `amount` into a trade that returned `retPct` % after charges.
export const rupees = (amount, retPct) => (fin(amount) && fin(retPct) ? (amount * retPct) / 100 : null);

// ------------------------------------------------------------ next session
export function nextPlan(d, amount, costs) {
  if (!d || !d.plans) return null;
  const call = (d.call && d.call.call) || "NO_TRADE";
  const kind = [d.call && d.call.kind, d.call && d.call.reference_kind, ...RULE_KEYS].find((k) => k && d.plans[k] && d.plans[k].levels);
  if (!kind) return null;
  const card = d.plans[kind], L = card.levels;
  if (![L.entry, L.stop, L.t1].every(fin) || !(L.entry > L.stop)) return null;
  const gap = kind === "gap_reversal";
  const sellAt = gap || !fin(L.t2) ? L.t1 : (L.t1 + L.t2) / 2;          // half at T1, half at T2
  const shares = fin(amount) && amount > 0 ? Math.floor(amount / L.entry) : 0;
  const buy = shares * L.entry;
  const best = shares ? shares * (sellAt - L.entry) - charges(buy, shares * sellAt, costs).total : 0;
  const worst = shares ? -(shares * (L.entry - L.stop) + charges(buy, shares * L.stop, costs).total) : 0;
  const last = (d.last && d.last.close) || null, c = d.claims || {};
  return {
    call, verdict: VERDICTS[call] || VERDICTS.NO_TRADE, kind, ruleTitle: RULE_TITLES[kind] || kind, gap,
    entry: L.entry, stop: L.stop, t1: L.t1, t2: gap ? null : L.t2, floor: fin(L.floor) ? L.floor : null,
    cancelAfter: card.cancel_after || "14:30", exitBy: card.exit_by || "15:15",
    shares, invested: buy, best, worst, needForOne: shares ? null : L.entry,
    pTrigger: fin(L.p_trigger) ? L.p_trigger : null,
    pUp: c.dir && fin(c.dir.p_up) ? c.dir.p_up : null,
    rangeLo: last && c.close && fin(c.close.p05) ? last * (1 + c.close.p05 / 100) : null,
    rangeHi: last && c.close && fin(c.close.p95) ? last * (1 + c.close.p95 / 100) : null,
    mostLikely: last && c.close && fin(c.close.p50) ? last * (1 + c.close.p50 / 100) : null,
    last,
  };
}

// ----------------------------------------------------------- past sessions
// compare.json row -> object (see publish.compare_file for the layout).
function rowObj(data, row) {
  if (!Array.isArray(row) || row.length < 10) return null;
  const [i, prev, p05, p50, p95, close, ret, pUp, right, inside, kind, status, planRet, entry, stop, rules, advice] = row;
  if (!data.days[i] || ![prev, p05, p95, close, ret].every(fin)) return null;
  const px = (p) => prev * (1 + p / 100);
  const ruleOut = {};
  RULE_KEYS.forEach((k, j) => {
    const v = Array.isArray(rules) ? rules[j] : null;
    ruleOut[k] = v === "n" ? { traded: false, ret: 0 } : fin(v) ? { traded: true, ret: v } : null;
  });
  if (kind && RULE_KEYS.includes(kind) && !ruleOut[kind]) {        // the shown plan's own result
    const noTrade = ["not_triggered", "cancelled", "none"].includes(status);
    ruleOut[kind] = noTrade ? { traded: false, ret: 0 } : fin(planRet) ? { traded: true, ret: planRet } : null;
  }
  return {
    date: data.days[i], track: (data.track && data.track[i]) || "backtest", prev, close, ret,
    lo: px(p05), hi: px(p95), mid: fin(p50) ? px(p50) : null, pUp: fin(pUp) ? pUp : null,
    right: right == null ? null : !!right, inside: inside == null ? ret >= p05 && ret <= p95 : !!inside,
    kind: kind || null, status: status || null, entry: fin(entry) ? entry : null, stop: fin(stop) ? stop : null,
    rules: ruleOut, advice: { N: "NO_TRADE", U: "NEUTRAL", F: "FAVOURABLE" }[advice] || null,
  };
}

// When the advice was "wait", was waiting right? Compares against what each plan would have done.
//   saved   : every plan that bought lost money  -> waiting avoided a loss
//   missed  : every plan that bought made money  -> waiting missed a gain
//   mixed   : some made, some lost
//   nothing : no plan bought anything            -> waiting cost nothing
//   unknown : the plans' results are not recorded
export function judgeWait(r, amount) {
  if (!r || r.advice !== "NO_TRADE") return null;
  const known = RULE_KEYS.filter((k) => r.rules[k]).map((k) => ({ kind: k, title: RULE_TITLES[k], ...r.rules[k], money: rupees(amount, r.rules[k].ret) }));
  if (!known.length) return { verdict: "unknown" };
  const traded = known.filter((x) => x.traded);
  const partial = known.length < RULE_KEYS.length;
  if (!traded.length) return { verdict: "nothing", partial };
  const worst = traded.reduce((a, x) => (x.money < a.money ? x : a)), best = traded.reduce((a, x) => (x.money > a.money ? x : a));
  const verdict = best.money <= 0 ? "saved" : worst.money > 0 ? "missed" : "mixed";
  return { verdict, worst, best, partial };
}

export function pastRows(data, symbol) {
  if (!data || !Array.isArray(data.days) || !data.stocks || !Array.isArray(data.stocks[symbol])) return [];
  return data.stocks[symbol].map((r) => rowObj(data, r)).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

const STATUS_TEXT = {
  not_triggered: "The price never reached the buy level, so the plan did nothing.",
  cancelled: "The market opened beyond the plan's limits, so it was cancelled before buying.",
  none: "There was no plan that day.",
  stopped: "It bought, the price then fell to the exit level, and the plan sold for a small, planned loss.",
  t1: "It bought and the price rose to the first profit level.",
  t2: "It bought and the price rose to the profit level.",
  time: "It bought, neither the profit nor the exit level was reached, and it sold at 3:15 PM.",
};

// The latest scored session for this stock, in money.
export function lastSession(rows, amount) {
  const r = rows && rows.length ? rows[rows.length - 1] : null;
  if (!r) return null;
  const shown = r.kind ? r.rules[r.kind] : null;
  return {
    ...r,
    wait: judgeWait(r, amount),
    followed: shown ? rupees(amount, shown.ret) : null,
    traded: shown ? shown.traded : null,
    story: STATUS_TEXT[r.status] || (shown && shown.traded ? "It bought and sold the same day." : "No plan result was recorded for this day."),
    others: RULE_KEYS.map((k) => ({ kind: k, title: RULE_TITLES[k], shown: k === r.kind,
      known: !!r.rules[k], traded: r.rules[k] ? r.rules[k].traded : null, money: r.rules[k] ? rupees(amount, r.rules[k].ret) : null })),
  };
}

// How the last `n` sessions went, and what following the shown plan each day would have made.
export function record(rows, amount, n = 20) {
  const list = (rows || []).slice(-n);
  if (!list.length) return null;
  const known = list.filter((r) => r.kind && r.rules[r.kind]);
  const trades = known.filter((r) => r.rules[r.kind].traded);
  const money = trades.map((r) => rupees(amount, r.rules[r.kind].ret));
  const perRule = {};
  for (const k of RULE_KEYS) {
    const k_rows = list.filter((r) => r.rules[k]);
    const k_trades = k_rows.filter((r) => r.rules[k].traded);
    perRule[k] = { days: k_rows.length, trades: k_trades.length, wins: k_trades.filter((r) => r.rules[k].ret > 0).length,
      total: k_trades.reduce((a, r) => a + rupees(amount, r.rules[k].ret), 0) };
  }
  const withDir = list.filter((r) => r.right != null);
  const judged = list.map((r) => judgeWait(r, amount)).filter(Boolean);
  const count = (v) => judged.filter((j) => j.verdict === v).length;
  const waits = { days: judged.length, saved: count("saved"), missed: count("missed"), mixed: count("mixed"), nothing: count("nothing"), unknown: count("unknown"),
    avoided: judged.filter((j) => j.verdict === "saved").reduce((a, j) => a - j.worst.money, 0),
    forgone: judged.filter((j) => j.verdict === "missed").reduce((a, j) => a + j.best.money, 0) };
  return {
    waits,
    n: list.length, live: list.filter((r) => r.track === "live").length,
    inside: list.filter((r) => r.inside).length,
    right: withDir.filter((r) => r.right).length, dirN: withDir.length,
    days: list.map((r) => ({ date: r.date, inside: r.inside, right: r.right, track: r.track })),
    planDays: known.length, trades: trades.length, wins: money.filter((x) => x > 0).length,
    total: money.reduce((a, x) => a + x, 0), best: money.length ? Math.max(...money) : null, worst: money.length ? Math.min(...money) : null,
    perRule,
  };
}

// Initials for a stock's round badge: "TATASTEEL" -> "TS" from the name, else first two letters.
export function monogram(symbol, name) {
  const words = String(name || "").replace(/\b(Ltd|Limited|Ltd\.|Corporation|Company|Industries|India|of)\b\.?/gi, " ").split(/[^A-Za-z]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(symbol || "?").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "?";
}
