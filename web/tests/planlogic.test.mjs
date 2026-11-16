// "Make a plan": input checks, feasibility, alternatives, and the page itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasData, install, readData } from "./fakedom.mjs";
import { LIMITS, makePlan, neededFor, shareAtLeast, sizePlan, validate } from "../js/planlogic.js";

const COSTS = {
  brokerage: { pct_per_order: 0.0003, max_per_order: 20 }, stt_sell: 0.00025, exchange_txn: 0.0000297, sebi_fee: 0.000001,
  stamp_duty_buy: 0.00003, gst: 0.18, slippage: { stop_exit_multiplier: 1.5 }, reference: { capital: 100000, risk_pct: 1 },
};
// A stock priced near `px` with a 2% stop: breakout targets at +2% and +4%, dip-buy the same shape lower down.
function stock(symbol, px, extra = {}) {
  const rule = (entry, over = {}) => ({
    entry, stop: +(entry * 0.98).toFixed(2), t1: +(entry * 1.02).toFixed(2), t2: +(entry * 1.04).toFixed(2), floor: null,
    p_trigger: 0.4, cancel_after: "14:30", exit_by: "15:15", trades: 800, win_rate: 0.4, expectancy_r: -0.15, shrunk_r: -0.15,
    enough: true, hit_t1: 0.2, hit_t2: 0.05, r_p05: -1.1, r_p25: -0.6, r_p50: -0.2, r_p75: 0.3, r_p95: 1.0, ...over,
  });
  return { symbol, name: symbol + " Ltd", close: px, call: "NO_TRADE", label: "no tested edge", kind: null, slippage: 0.0005, close_p95: 2.5,
           rules: { breakout: rule(px * 1.01), pullback: rule(px * 0.99, { p_trigger: 0.3 }) }, ...extra };
}
const PLANNER = {
  for_date: "2026-11-16", plan_status: "scored",
  stocks: [stock("AAA", 500), stock("BBB", 1200), stock("CCC", 2500), stock("DDD", 300), stock("EEE", 800), stock("FFF", 4000),
           stock("GGG", 150), stock("HHH", 950), stock("III", 620), stock("JJJ", 1800)],
};
const plan = (amount, target, risk, planner = PLANNER) => makePlan(planner, COSTS, { amount, target, risk });

// ------------------------------------------------------------- validation
test("valid inputs are accepted, including text with commas and a rupee sign", () => {
  const v = validate({ amount: "₹1,00,000", target: "500", risk: "1.5%" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.values, { amount: 100000, target: 500, risk: 1.5 });
});

test("each invalid value gets its own explanation", () => {
  const cases = [
    [{ amount: "", target: "", risk: "" }, ["amount", "target", "risk"]],
    [{ amount: "abc", target: 100, risk: 1 }, ["amount"]],
    [{ amount: -5, target: 100, risk: 1 }, ["amount"]],
    [{ amount: 50, target: 100, risk: 1 }, ["amount"]],
    [{ amount: LIMITS.maxAmount + 1, target: 100, risk: 1 }, ["amount"]],
    [{ amount: 1000, target: 0, risk: 1 }, ["target"]],
    [{ amount: 1000, target: -10, risk: 1 }, ["target"]],
    [{ amount: 1000, target: 10, risk: -1 }, ["risk"]],
    [{ amount: 1000, target: 10, risk: 101 }, ["risk"]],
    [{ amount: "1e999", target: 10, risk: "x" }, ["amount", "risk"]],
  ];
  for (const [raw, bad] of cases) {
    const r = makePlan(PLANNER, COSTS, raw);
    assert.equal(r.status, "invalid", JSON.stringify(raw));
    assert.deepEqual(Object.keys(r.errors).sort(), bad.slice().sort(), JSON.stringify(raw));
    for (const k of bad) assert.ok(r.errors[k].length > 10, "a readable sentence");
    assert.equal(r.plans.length, 0);
  }
});

test("0% risk is a valid input (it is judged, not rejected)", () => {
  assert.equal(validate({ amount: 1000, target: 100, risk: 0 }).ok, true);
});

// ----------------------------------------------------------------- sizing
test("a sized plan respects both the cash and the loss limit, after charges", () => {
  for (const [amount, risk] of [[100000, 1], [100000, 0.2], [5000, 5], [1000000, 0.5]]) {
    const budget = (amount * risk) / 100;
    for (const s of PLANNER.stocks) for (const [kind, rule] of Object.entries(s.rules)) {
      const p = sizePlan(s, kind, rule, amount, budget, COSTS);
      assert.ok(Number.isInteger(p.shares) && p.shares >= 0);
      assert.ok(p.value <= amount + 1e-6, "never spends more than the amount");
      assert.ok(p.lossAtStop <= budget + 1e-6, "never risks more than the tolerance");
      if (p.shares) {
        assert.ok(p.lossAtStop > p.shares * (rule.entry - rule.stop), "loss includes charges and slippage");
        assert.ok(p.bestGain < p.shares * ((rule.t1 + rule.t2) / 2 - rule.entry), "gain is net of charges and slippage");
      }
    }
  }
});

test("a rule with unusable levels is skipped rather than guessed", () => {
  const s = stock("BAD", 500);
  assert.equal(sizePlan(s, "breakout", { ...s.rules.breakout, stop: null }, 1e5, 1e3, COSTS), null);
  assert.equal(sizePlan(s, "breakout", { ...s.rules.breakout, stop: 600 }, 1e5, 1e3, COSTS), null);      // stop above entry
  assert.equal(sizePlan(s, "breakout", { ...s.rules.breakout, t1: NaN }, 1e5, 1e3, COSTS), null);
  assert.equal(neededFor(s, "breakout", { ...s.rules.breakout, entry: undefined }, 100, COSTS), null);
});

test("the chance of reaching a result is read off the rule's past results", () => {
  const rule = PLANNER.stocks[0].rules.breakout;
  assert.deepEqual(shareAtLeast(rule, -5), { p: 0.95, bound: null });
  assert.equal(shareAtLeast(rule, -0.2).p, 0.5);
  assert.ok(Math.abs(shareAtLeast(rule, 0.05).p - 0.375) < 1e-9);                 // halfway between the median and the 75th
  assert.deepEqual(shareAtLeast(rule, 1.4), { p: 0.05, bound: "under" });          // beyond the 95th: only a ceiling is known
  assert.equal(shareAtLeast({}, 0.5), null);
});

// ------------------------------------------------------------ feasibility
test("a compatible request returns 4 to 8 plans, one per stock, each complete", () => {
  const r = plan(100000, 500, 1);
  assert.equal(r.status, "feasible");
  assert.ok(r.plans.length >= 4 && r.plans.length <= 8);
  assert.equal(new Set(r.plans.map((p) => p.symbol)).size, r.plans.length, "distinct stocks");
  assert.equal(r.forDate, "2026-11-16");
  for (const p of r.plans) {
    assert.ok(p.shares > 0 && p.bestGain >= 500, "every plan shown can reach the target in its best case");
    assert.ok(p.lossAtStop <= 1000 + 1e-6 && p.value <= 100000);
    assert.ok(p.entry > p.stop && p.t1 > p.entry, "entry and exit levels");
    assert.ok(p.cancelAfter && p.exitBy, "holding period");
    assert.ok(["NO_TRADE", "NEUTRAL", "FAVOURABLE"].includes(p.call), "signal");
    assert.ok(p.pTarget > 0 && p.pTarget < 1 && p.pTrigger > 0, "chances are estimates between 0 and 1");
    assert.ok(Number.isFinite(p.expectancyR) && Number.isFinite(p.typicalRs), "the rule's record is attached");
  }
  assert.ok(r.summary.chanceHi < 0.5, "no plan is presented as likely");
  assert.equal(r.summary.negativeRecord, r.plans.length, "losing records are counted so the page can say so");
});

test("plans the tool itself called are listed first", () => {
  const planner = structuredClone(PLANNER);
  Object.assign(planner.stocks[7], { call: "NEUTRAL", label: "weak evidence", kind: "pullback" });
  const r = plan(100000, 300, 1, planner);
  assert.equal(r.plans[0].symbol, "HHH");
  assert.equal(r.plans[0].kind, "pullback");
  assert.equal(r.plans[0].called, true);
});

test("fewer than four plans are shown when the data supports fewer", () => {
  const r = plan(100000, 500, 1, { ...PLANNER, stocks: PLANNER.stocks.slice(0, 2) });
  assert.equal(r.status, "feasible");
  assert.equal(r.plans.length, 2);
  assert.equal(r.summary.fewerThanMin, true);
});

test("Rs 1,000 with a Rs 10,000 target and 0% risk is explained, with alternatives that work", () => {
  const r = plan(1000, 10000, 0);
  assert.equal(r.status, "infeasible");
  assert.equal(r.plans.length, 0, "nothing can be sized at 0% risk");
  assert.ok(r.reasons.some((t) => /0%/.test(t) && /risk/i.test(t)), "says why 0% risk rules everything out");
  assert.ok(r.reasons.some((t) => /1000%/.test(t)), "says how large the required gain is");

  const max = r.alternatives.find((a) => a.key === "max_at_amount");
  const need = r.alternatives.find((a) => a.key === "for_target");
  assert.ok(max && need, "both alternatives are offered");
  assert.equal(max.apply.amount, 1000);
  assert.ok(max.apply.target < 100 && max.apply.risk > 0, "the most Rs 1,000 could earn, and the risk that goes with it");
  assert.equal(need.apply.target, 10000);
  assert.ok(need.apply.amount > 100000 && need.apply.risk > 0, "the amount and risk a Rs 10,000 target would take");
  for (const a of r.alternatives) {
    assert.ok(a.chance == null || (a.chance >= 0 && a.chance < 0.5));
    assert.equal(makePlan(PLANNER, COSTS, a.apply).status, "feasible", `"${a.title}" leads to plans when applied`);
  }
});

test("a target beyond the risk limit offers a lower target and still shows the closest plans", () => {
  const r = plan(100000, 4500, 1);
  assert.equal(r.status, "infeasible");
  const lower = r.alternatives.find((a) => a.key === "lower_target");
  assert.ok(lower && lower.apply.target < 4500 && lower.apply.risk === 1 && lower.apply.amount === 100000);
  assert.ok(r.plans.length >= 4 && r.plans.every((p) => p.bestGain < 4500 && p.lossAtStop <= 1000 + 1e-6));
  assert.equal(makePlan(PLANNER, COSTS, lower.apply).status, "feasible");
});

test("an amount too small for one share says so", () => {
  const r = plan(120, 5, 50);
  assert.equal(r.status, "infeasible");
  assert.ok(r.reasons.some((t) => /does not buy one share/.test(t)));
});

test("missing or empty planning data is reported, not thrown", () => {
  for (const planner of [null, {}, { stocks: [] }]) {
    const r = makePlan(planner, COSTS, { amount: 100000, target: 500, risk: 1 });
    assert.equal(r.status, "no_data");
    assert.ok(r.reasons[0].length > 10);
  }
  const broken = { stocks: [{ symbol: "X", rules: { breakout: { entry: null } } }, { symbol: "Y" }, stock("ZZZ", 700)] };
  assert.equal(makePlan(broken, COSTS, { amount: 100000, target: 500, risk: 1 }).plans.length, 1, "broken rows are skipped");
});

test("the wording never promises a return", () => {
  const texts = [];
  for (const args of [[1000, 10000, 0], [100000, 4500, 1], [120, 5, 50]]) {
    const r = plan(...args);
    texts.push(...r.reasons, ...r.alternatives.flatMap((a) => [a.title, a.text]));
  }
  for (const t of texts) assert.ok(!/guarantee|will earn|will make|sure to|risk-free plan/i.test(t), t);
});

// ---------------------------------------------------------- published data
test("the published planner file gives sensible answers", { skip: !hasData() && "published data files are not present" }, () => {
  const planner = readData("planner.json"), meta = readData("meta.json");
  assert.equal(planner.for_date, meta.plan_for_date, "it is for the session the app has planned");
  assert.ok(planner.stocks.length >= 40);
  const ok = makePlan(planner, meta.costs, { amount: 100000, target: 500, risk: 1 });
  assert.equal(ok.status, "feasible");
  assert.ok(ok.plans.length >= 4 && ok.plans.length <= 8);
  const no = makePlan(planner, meta.costs, { amount: 1000, target: 10000, risk: 0 });
  assert.equal(no.status, "infeasible");
  for (const a of no.alternatives) assert.equal(makePlan(planner, meta.costs, a.apply).status, "feasible");
});

// ---------------------------------------------------------------- the page
test("the page has three inputs and a Make a plan button, and shows plans or reasons", async () => {
  install({ "meta.json": { costs: COSTS }, "planner.json": PLANNER });
  const { renderPlan } = await import("../js/plan.js");
  const root = document.createElement("div");
  document.body.append(root);
  const went = [];
  await renderPlan(root, { meta: { costs: COSTS, plan_for_date: "2026-11-16", plan_status: "scored" }, go: (...a) => went.push(a) });

  const inputs = root.querySelectorAll("input");
  assert.deepEqual(inputs.map((i) => i.getAttribute("id")), ["p-amount", "p-target", "p-risk"], "exactly three inputs");
  const button = root.querySelectorAll("button").find((b) => b.textContent === "Make a plan");
  assert.ok(button && button.getAttribute("type") === "submit");
  assert.match(root.textContent, /16-Nov-2026/, "names the session it plans for");
  const submit = () => root.querySelector("form").dispatchEvent({ type: "submit", preventDefault() {} });
  const set = (a, t, r) => { inputs[0].value = a; inputs[1].value = t; inputs[2].value = r; };

  set("", "-4", "250"); submit();
  assert.equal(root.querySelectorAll(".pcard").length, 0);
  assert.equal(root.querySelectorAll(".field-err").filter((e) => e.textContent).length, 3, "each bad value is explained beside its field");

  set("100000", "500", "1"); submit();
  const cards = root.querySelectorAll(".pcard");
  assert.ok(cards.length >= 4 && cards.length <= 8);
  assert.equal(root.querySelectorAll(".field-err").filter((e) => e.textContent).length, 0);
  for (const c of cards) {
    assert.match(c.textContent, /BUY SIGNAL/); assert.match(c.textContent, /SELL SIGNAL/);
    assert.match(c.textContent, /Holding period/); assert.match(c.textContent, /Loss if the stop is hit/);
    assert.match(c.textContent, /Estimated best case/);
  }
  assert.match(root.textContent, /does not guarantee/i);
  assert.ok(!/undefined|NaN/.test(root.textContent));
  cards[0].querySelectorAll("button").at(-1).click();
  assert.equal(went[0][0], "today");
  assert.ok(went[0][1].s && went[0][1].k, "a plan links to its stock and rule on the Today page");

  set("1000", "10000", "0"); submit();
  assert.match(root.textContent, /NOT COMPATIBLE/);
  const use = root.querySelectorAll("button").filter((b) => b.textContent === "Use these numbers");
  assert.ok(use.length >= 2);
  use[0].click();                                                     // an alternative fills the form and re-runs
  assert.ok(root.querySelectorAll(".pcard").length >= 1);
  assert.match(root.textContent, /POSSIBLE, NOT PROMISED/);
  assert.ok(!/undefined|NaN/.test(root.textContent));
});
