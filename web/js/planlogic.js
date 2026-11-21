// "Make a plan": checks whether an amount, a one-day earnings target and a risk
// tolerance fit together, using only what the pipeline already published
// (planner.json: each stock's levels and each rule's measured record).
//
// Nothing here forecasts anything new. It sizes the published levels for the
// viewer's money and reports what the rules did in the past. No page
// dependencies, so it runs under Node for tests.
import { charges, tradePrices } from "./money.js";

export const LIMITS = { minAmount: 100, maxAmount: 1e8, maxTarget: 1e9 };
export const RULE_NAMES = { breakout: "Breakout", pullback: "Dip buy", gap_reversal: "Gap reversal" };
export const MAX_PLANS = 8, MIN_PLANS = 4;

const fin = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (fin(x) ? x : null);
const inr = (x) => "₹" + Math.round(x).toLocaleString("en-IN");

// ------------------------------------------------------------- validation
function parse(raw) {
  if (typeof raw === "number") return raw;
  const text = String(raw ?? "").replace(/[,₹%\s]/g, "");
  return text === "" ? null : Number(text);
}
export function validate(raw) {
  const errors = {};
  const amount = parse(raw.amount), target = parse(raw.target), risk = parse(raw.risk);
  if (amount == null) errors.amount = "Enter the amount you would invest.";
  else if (!Number.isFinite(amount)) errors.amount = "The investment amount is not a number.";
  else if (amount <= 0) errors.amount = "The investment amount has to be more than zero.";
  else if (amount < LIMITS.minAmount) errors.amount = `Enter at least ${inr(LIMITS.minAmount)}; smaller amounts cannot buy a single share of any Nifty 50 stock.`;
  else if (amount > LIMITS.maxAmount) errors.amount = `Enter ${inr(LIMITS.maxAmount)} or less. Larger orders would move the price, which these estimates do not model.`;

  if (target == null) errors.target = "Enter how much you would like to earn on the day.";
  else if (!Number.isFinite(target)) errors.target = "The earnings target is not a number.";
  else if (target <= 0) errors.target = "The earnings target has to be more than zero.";
  else if (target > LIMITS.maxTarget) errors.target = `Enter ${inr(LIMITS.maxTarget)} or less.`;

  if (risk == null) errors.risk = "Enter the share of the amount you could accept losing, from 0 to 100.";
  else if (!Number.isFinite(risk)) errors.risk = "The risk tolerance is not a number.";
  else if (risk < 0) errors.risk = "The risk tolerance cannot be negative.";
  else if (risk > 100) errors.risk = "The risk tolerance cannot be more than 100% of the amount.";

  return { ok: Object.keys(errors).length === 0, errors, values: { amount, target, risk } };
}

// ----------------------------------------------------------------- sizing
// Per-share figures for one rule on one stock: the shared fill rules in money.js, which
// copy the pipeline's (no slippage on the dip buy's limit order, the gap rule's stop follows its fill).
function perShare(stock, kind, rule, costs) {
  const p = tradePrices(kind, rule, fin(stock.slippage) ? stock.slippage : 0, costs);
  return { fill: p.fill, stopFill: p.stopExit, bestExit: p.bestExit };
}
function lossFor(n, ps, costs) { return n * (ps.fill - ps.stopFill) + charges(n * ps.fill, n * ps.stopFill, costs).total; }
function gainFor(n, ps, costs) { return n * (ps.bestExit - ps.fill) - charges(n * ps.fill, n * ps.bestExit, costs).total; }

// Largest whole number n in [0, hi] with test(n) true, where test is true up to some point then false.
function lastTrue(hi, test) {
  let lo = 0;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (test(mid)) lo = mid; else hi = mid - 1; }
  return lo;
}

function usable(rule) {
  return rule && fin(rule.entry) && fin(rule.stop) && fin(rule.t1) && fin(rule.t2) && rule.stop > 0 && rule.entry > rule.stop && rule.t1 > rule.entry;
}

// Share of this rule's past trades that ended at `r` (in R, after costs) or better,
// read off the published quantiles. Beyond the 95th percentile only an upper bound
// is known ("fewer than 1 in 20"), which is flagged rather than guessed.
export function shareAtLeast(rule, r) {
  const pts = [[rule.r_p05, 0.95], [rule.r_p25, 0.75], [rule.r_p50, 0.5], [rule.r_p75, 0.25], [rule.r_p95, 0.05]]
    .filter(([x]) => fin(x));
  if (pts.length < 2) return null;
  if (r <= pts[0][0]) return { p: pts[0][1], bound: null };
  const last = pts[pts.length - 1];
  if (r > last[0]) return { p: last[1], bound: "under" };
  for (let i = 1; i < pts.length; i++) {
    const [x0, p0] = pts[i - 1], [x1, p1] = pts[i];
    if (r <= x1) return { p: x1 === x0 ? p1 : p0 + ((r - x0) / (x1 - x0)) * (p1 - p0), bound: null };
  }
  return { p: last[1], bound: null };
}

// One rule on one stock, sized for `amount` with at most `lossBudget` rupees lost at the stop.
// `target` (optional) adds the estimated chance of earning at least that much.
export function sizePlan(stock, kind, rule, amount, lossBudget, costs, target = null) {
  if (!usable(rule)) return null;
  const ps = perShare(stock, kind, rule, costs);
  const byCash = Math.floor(amount / ps.fill);
  const byRisk = lastTrue(byCash, (n) => lossFor(n, ps, costs) <= lossBudget);
  const shares = Math.min(byCash, byRisk);
  const value = shares * ps.fill;
  const lossAtStop = shares ? lossFor(shares, ps, costs) : 0;
  const bestGain = shares ? gainFor(shares, ps, costs) : 0;
  const riskRs = shares * (rule.entry - rule.stop);                    // 1 R in rupees
  const pTrigger = num(rule.p_trigger);
  const hitBest = kind === "gap_reversal" ? num(rule.hit_t1) : num(rule.hit_t2);
  const called = stock.call && stock.call !== "NO_TRADE" && stock.kind === kind;
  const record = fin(rule.shrunk_r) ? rule.shrunk_r : num(rule.expectancy_r);
  let pTarget = null, pTargetBound = null;
  if (target != null && shares && riskRs > 0 && pTrigger != null) {
    const s = shareAtLeast(rule, target / riskRs);
    if (s) { pTarget = pTrigger * s.p; pTargetBound = s.bound; }
  }
  return {
    pTarget, pTargetBound,
    symbol: stock.symbol, name: stock.name || stock.symbol, kind, ruleName: RULE_NAMES[kind] || kind,
    call: stock.call || "NO_TRADE", callLabel: stock.label || "", called,
    entry: rule.entry, stop: rule.stop, t1: rule.t1, t2: rule.t2, floor: num(rule.floor),
    cancelAfter: rule.cancel_after || "14:30", exitBy: rule.exit_by || "15:15",
    shares, value, limitedBy: byRisk < byCash ? "risk" : "cash",
    lossAtStop, lossPct: amount > 0 ? (lossAtStop / amount) * 100 : 0,
    bestGain, bestGainPct: value > 0 ? (bestGain / value) * 100 : 0,
    movePct: (ps.bestExit / ps.fill - 1) * 100,
    pTrigger, pBest: pTrigger != null && hitBest != null ? pTrigger * hitBest : null,
    winRate: num(rule.win_rate), trades: rule.trades || 0, enough: !!rule.enough,
    expectancyR: num(rule.expectancy_r), record,
    typicalRs: fin(rule.r_p50) ? rule.r_p50 * riskRs : null,
    expectedRs: pTrigger != null && fin(rule.expectancy_r) ? pTrigger * rule.expectancy_r * riskRs : null,
  };
}

// Fewest shares of this rule whose best case reaches `target`, and what that needs.
export function neededFor(stock, kind, rule, target, costs) {
  if (!usable(rule)) return null;
  const ps = perShare(stock, kind, rule, costs);
  let hi = Math.max(1, Math.ceil(target / Math.max(ps.bestExit - ps.fill, 1e-9)));
  for (let i = 0; i < 40 && gainFor(hi, ps, costs) < target; i++) hi *= 2;
  if (gainFor(hi, ps, costs) < target) return null;                    // costs eat the whole move
  const shares = lastTrue(hi, (n) => gainFor(n, ps, costs) < target) + 1;
  const investment = shares * ps.fill, loss = lossFor(shares, ps, costs);
  return { symbol: stock.symbol, kind, ruleName: RULE_NAMES[kind] || kind, shares, investment, loss, lossPct: (loss / investment) * 100 };
}

// ---------------------------------------------------------------- ranking
// Plans the tool itself called come first (if they can trigger at all), then the
// better estimated chance of reaching the target, then the less-bad measured record.
// One plan per stock.
function better(a, b) {
  const ca = a.called && (a.pTrigger ?? 0) > 0, cb = b.called && (b.pTrigger ?? 0) > 0;
  if (ca !== cb) return ca ? -1 : 1;
  const pa = a.pTarget ?? 0, pb = b.pTarget ?? 0;
  if (pa !== pb) return pb - pa;
  const ra = a.record ?? -Infinity, rb = b.record ?? -Infinity;
  return rb - ra || a.symbol.localeCompare(b.symbol);
}
const byGain = (a, b) => b.bestGain - a.bestGain || a.symbol.localeCompare(b.symbol);
function allPlans(planner, amount, lossBudget, costs, target = null) {
  const out = [];
  for (const stock of (planner && planner.stocks) || []) {
    for (const [kind, rule] of Object.entries(stock.rules || {})) {
      const p = sizePlan(stock, kind, rule, amount, lossBudget, costs, target);
      if (p) out.push(p);
    }
  }
  return out;
}
function onePerStock(plans, order = better) {
  const seen = new Set(), out = [];
  for (const p of plans.slice().sort(order)) if (!seen.has(p.symbol)) { seen.add(p.symbol); out.push(p); }
  return out;
}

// ------------------------------------------------------------ the main call
export function makePlan(planner, costs, raw) {
  const v = validate(raw);
  const base = { forDate: planner ? planner.for_date : null, planStatus: planner ? planner.plan_status : null };
  if (!v.ok) return { ...base, status: "invalid", errors: v.errors, inputs: v.values, plans: [], reasons: [], alternatives: [] };

  const { amount, target, risk } = v.values;
  const stocks = (planner && planner.stocks) || [];
  if (!stocks.length) {
    return { ...base, status: "no_data", errors: {}, inputs: v.values, plans: [], alternatives: [],
             reasons: ["No plan levels are published for this session yet, so there is nothing to size."] };
  }

  const budget = (amount * risk) / 100;
  const sized = allPlans(planner, amount, budget, costs, target);
  const live = sized.filter((p) => p.shares > 0);
  const meeting = onePerStock(live.filter((p) => p.bestGain >= target));

  if (meeting.length) {
    const plans = meeting.slice(0, MAX_PLANS);
    const chances = plans.map((p) => p.pTarget).filter((x) => x != null);
    return {
      ...base, status: "feasible", errors: {}, inputs: v.values, plans, reasons: [], alternatives: [],
      summary: {
        stocksMeeting: meeting.length, shown: plans.length, fewerThanMin: plans.length < MIN_PLANS,
        chanceLo: chances.length ? Math.min(...chances) : null, chanceHi: chances.length ? Math.max(...chances) : null,
        negativeRecord: plans.filter((p) => (p.record ?? -1) <= 0).length,
        calledCount: plans.filter((p) => p.called).length,
      },
    };
  }

  // ---- not compatible: say why, then offer what the numbers do support
  const reasons = [], alternatives = [];
  const open = allPlans(planner, amount, amount, costs).filter((p) => p.shares > 0);   // cash is the only limit
  const cheapest = Math.min(...sized.map((p) => p.entry));
  const maxMove = Math.max(...sized.map((p) => p.movePct));
  const needPct = (target / amount) * 100;

  if (risk === 0) reasons.push("A risk tolerance of 0% leaves no room for any position. Every plan has a stop below its entry, so every plan can lose money; none is risk-free.");
  if (!open.length) reasons.push(`${inr(amount)} does not buy one share at any of today's entry levels. The lowest entry is about ${inr(cheapest)} a share.`);
  if (needPct > maxMove) reasons.push(`Earning ${inr(target)} on ${inr(amount)} needs a gain of ${needPct >= 100 ? Math.round(needPct) : needPct.toFixed(1)}% in one session. The furthest target in today's levels is about ${maxMove.toFixed(1)}% above its entry.`);

  const bestOf = (list) => list.slice().sort((a, b) => b.bestGain - a.bestGain)[0];
  const topLive = bestOf(live), topOpen = bestOf(open);
  if (risk > 0 && topLive && topLive.bestGain > 0) {
    reasons.push(`Within a loss limit of ${inr(budget)} (${risk}% of ${inr(amount)}), the most these levels could earn is about ${inr(topLive.bestGain)}, which is short of ${inr(target)}.`);
    alternatives.push({
      key: "lower_target", title: `Keep ${inr(amount)} and ${risk}% risk, aim lower`,
      text: `The largest best-case gain is about ${inr(topLive.bestGain)} (${topLive.symbol}, ${topLive.ruleName.toLowerCase()}), with about ${inr(topLive.lossAtStop)} lost if the stop is hit.`,
      chance: topLive.pBest, apply: { amount, target: Math.max(1, Math.floor(topLive.bestGain)), risk },
    });
  } else if (risk > 0 && open.length && !live.length) {
    reasons.push(`A loss limit of ${inr(budget)} (${risk}% of ${inr(amount)}) is smaller than the loss on a single share at the stop, after charges.`);
  }
  if (topOpen && topOpen.bestGain > 0 && (!topLive || topOpen.bestGain > topLive.bestGain + 0.5)) {
    const needRisk = Math.min(100, Math.ceil(topOpen.lossPct * 10 + 1e-9) / 10);
    alternatives.push({
      key: "max_at_amount", title: `The most ${inr(amount)} could earn`,
      text: `About ${inr(topOpen.bestGain)} in the best case (${topOpen.symbol}, ${topOpen.ruleName.toLowerCase()}), and only by accepting a loss of about ${inr(topOpen.lossAtStop)} if the stop is hit: a risk tolerance of ${needRisk}%.`,
      chance: topOpen.pBest, apply: { amount, target: Math.max(1, Math.floor(topOpen.bestGain)), risk: needRisk },
    });
  }
  let need = null;
  for (const stock of stocks) {
    for (const [kind, rule] of Object.entries(stock.rules || {})) {
      const n = neededFor(stock, kind, rule, target, costs);
      if (n && (!need || n.investment < need.investment)) need = n;
    }
  }
  if (need) {
    const newAmount = Math.ceil(need.investment / 100) * 100;
    if (newAmount <= LIMITS.maxAmount) {
      const newRisk = Math.min(100, Math.ceil((need.loss / newAmount) * 1000 + 1e-9) / 10);
      const sizedThere = sizePlan(stocks.find((s) => s.symbol === need.symbol), need.kind,
        stocks.find((s) => s.symbol === need.symbol).rules[need.kind], newAmount, (newAmount * newRisk) / 100, costs);
      alternatives.push({
        key: "for_target", title: `What pursuing ${inr(target)} would take`,
        text: `About ${inr(newAmount)} invested, with about ${inr(need.loss)} of it (${newRisk}%) lost if the stop is hit (${need.symbol}, ${need.ruleName.toLowerCase()}). That is the smallest amount for which any of today's levels reaches the target in the best case.`,
        chance: sizedThere ? sizedThere.pBest : null, apply: { amount: newAmount, target, risk: newRisk },
      });
    } else {
      reasons.push(`Reaching ${inr(target)} at today's levels would take more than ${inr(LIMITS.maxAmount)}, which is beyond what this tool sizes for.`);
    }
  }
  if (!reasons.length) reasons.push(`None of today's levels reaches ${inr(target)} with ${inr(amount)} and a ${risk}% risk tolerance.`);

  // The closest plans that do fit the amount and the risk limit, even though they fall short.
  const closest = onePerStock(live, byGain).slice(0, MAX_PLANS);
  return { ...base, status: "infeasible", errors: {}, inputs: v.values, plans: closest, reasons, alternatives,
           summary: { needPct, maxMovePct: maxMove, budget } };
}
