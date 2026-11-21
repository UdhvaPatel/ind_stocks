// Home page: the next plan in money, last session's result, the recent record, and the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasData, install, readData } from "./fakedom.mjs";
import { judgeWait, lastSession, monogram, nextPlan, pastRows, record, rupees } from "../js/homelogic.js";

const COSTS = {
  brokerage: { pct_per_order: 0.0003, max_per_order: 20 }, stt_sell: 0.00025, exchange_txn: 0.0000297, sebi_fee: 0.000001,
  stamp_duty_buy: 0.00003, gst: 0.18, slippage: { stop_exit_multiplier: 1.5 }, reference: { capital: 100000, risk_pct: 1 },
};
const SYMBOL = {
  symbol: "AAA", for_date: "2026-11-23", last: { close: 1000, change_pct: 0.5 },
  call: { call: "NO_TRADE", kind: null, reference_kind: "gap_reversal" },
  claims: { dir: { p_up: 0.46 }, close: { p05: -2, p50: 0.1, p95: 2.5 } },
  plans: {
    breakout: { levels: { entry: 1010, stop: 990, t1: 1030, t2: 1050, p_trigger: 0.4 }, cancel_after: "14:30", exit_by: "15:15" },
    gap_reversal: { levels: { entry: 985, stop: 955, t1: 1000, t2: 1000, floor: 950, p_trigger: 0.03 }, cancel_after: "14:30", exit_by: "15:15" },
  },
};
// Two days; row layout from publish.compare_file.
const COMPARE = {
  days: ["2026-11-19", "2026-11-20"], track: ["backtest", "live"], daily: [[0.5, 0.9, 0.5, 0, 50], [0.4, 0.8, 0.6, 0.2, 50]],
  stocks: { AAA: [
    [0, 1000, -2, 0.1, 2, 1010, 1, 0.55, 1, 1, "gap_reversal", "not_triggered", null, 980, 950, [1.2, null, "n"]],
    [1, 1010, -2, 0.1, 2, 1040, 2.97, 0.45, 0, 0, "breakout", "time", 0.8, 1015, 995, [0.8, -1.5, "n"], "U"],
  ] },
};

test("money for a past trade is the amount times its net return", () => {
  assert.equal(rupees(50000, 0.8), 400);
  assert.equal(rupees(50000, -1.5), -750);
  assert.equal(rupees(50000, null), null);
});

test("the next plan uses the tool's own pick and sizes it for the amount", () => {
  const p = nextPlan(SYMBOL, 50000, COSTS);
  assert.equal(p.kind, "gap_reversal", "no call, so the reference plan is shown");
  assert.equal(p.verdict.badge, "Wait");
  assert.equal(p.shares, 50);                                            // floor(50000 / 985)
  assert.ok(p.best > 0 && p.best < 50 * 15, "best case after charges");
  assert.ok(p.worst < -50 * 30, "worst case includes charges");
  assert.deepEqual([p.rangeLo, p.rangeHi], [980, 1025]);
  assert.equal(p.pUp, 0.46);
  assert.equal(p.t2, null, "the low-opening plan has one target");

  const called = nextPlan({ ...SYMBOL, call: { call: "NEUTRAL", kind: "breakout" } }, 50000, COSTS);
  assert.equal(called.kind, "breakout"); assert.equal(called.verdict.badge, "Weak signal"); assert.equal(called.t2, 1050);
  const poor = nextPlan(SYMBOL, 500, COSTS);
  assert.equal(poor.shares, 0); assert.equal(poor.needForOne, 985);
  assert.equal(nextPlan({ plans: {} }, 1000, COSTS), null);
  assert.equal(nextPlan(null, 1000, COSTS), null);
});

test("past rows read back each rule's result", () => {
  const rows = pastRows(COMPARE, "AAA");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].rules, { breakout: { traded: true, ret: 1.2 }, pullback: null, gap_reversal: { traded: false, ret: 0 } });
  assert.deepEqual([rows[1].lo, rows[1].hi], [989.8, 1030.2]);
  assert.deepEqual(pastRows(COMPARE, "ZZZ"), []);
  assert.deepEqual(pastRows(null, "AAA"), []);
});

test("last session: what following the shown plan would have earned", () => {
  const L = lastSession(pastRows(COMPARE, "AAA"), 50000);
  assert.equal(L.date, "2026-11-20"); assert.equal(L.track, "live");
  assert.equal(L.kind, "breakout"); assert.equal(L.followed, 400); assert.equal(L.traded, true);
  assert.match(L.story, /sold at 3:15 PM/);
  assert.deepEqual(L.others.map((o) => [o.kind, o.known, o.traded, o.money]),
    [["breakout", true, true, 400], ["pullback", true, true, -750], ["gap_reversal", true, false, 0]]);
  const quiet = lastSession(pastRows(COMPARE, "AAA").slice(0, 1), 50000);
  assert.equal(quiet.followed, 0); assert.equal(quiet.traded, false);
  assert.match(quiet.story, /never reached the buy level/);
  assert.equal(quiet.others[1].known, false, "an unrecorded rule says so instead of guessing");
  assert.equal(lastSession([], 50000), null);
});

test("the record counts correct predictions and adds up following the plan", () => {
  const R = record(pastRows(COMPARE, "AAA"), 50000, 20);
  assert.equal(R.n, 2); assert.equal(R.inside, 1); assert.equal(R.right, 1); assert.equal(R.live, 1);
  assert.equal(R.planDays, 2); assert.equal(R.trades, 1); assert.equal(R.wins, 1); assert.equal(R.total, 400);
  assert.deepEqual(R.perRule.breakout, { days: 2, trades: 2, wins: 2, total: 1000 });
  assert.equal(record([], 1000), null);
});

test("a 'wait' day is judged only against the one plan shown that morning (no hindsight)", () => {
  // the shown plan is "buy on a rise" (breakout); the other rules must not affect the verdict
  const day = (rules, advice = "N", kind = "breakout") => pastRows({ days: ["2026-11-20"], track: ["live"], daily: [],
    stocks: { X: [[0, 100, -2, 0, 2, 101, 1, 0.5, 1, 1, kind, kind ? "time" : null, null, 98, 95, rules, advice]] } }, "X")[0];
  const saved = judgeWait(day([-1.2, 0.9, "n"]), 50000);               // another rule made money: irrelevant
  assert.equal(saved.verdict, "saved"); assert.equal(saved.plan.kind, "breakout"); assert.equal(saved.plan.money, -600);
  const missed = judgeWait(day([0.8, -3, "n"]), 50000);
  assert.equal(missed.verdict, "missed"); assert.equal(missed.plan.money, 400);
  assert.equal(judgeWait(day(["n", 2.0, "n"]), 50000).verdict, "nothing", "the shown plan never bought");
  assert.equal(judgeWait(day([null, 2.0, "n"]), 50000).verdict, "unknown");
  assert.equal(judgeWait(day([0.8, -0.5, "n"], "U"), 50000), null, "only 'wait' days are judged this way");

  const R = record([day([-1.2, 1, "n"]), day([0.8, -1, "n"]), day(["n", 1, "n"]), day([0.5, null, "n"], "U")], 50000);
  assert.deepEqual([R.waits.days, R.waits.saved, R.waits.missed, R.waits.nothing], [3, 1, 1, 1]);
  assert.equal(R.waits.avoided, 600); assert.equal(R.waits.forgone, 400);
  assert.equal(lastSession([day([-1.2, 1, "n"])], 50000).wait.verdict, "saved");
});

test("the next plan uses the scoreboard's fill rules", () => {
  // dip buy: limit order, no entry slippage; breakout: entry slippage; best case = half at each target
  const d = (kind) => ({ ...SYMBOL, slippage: 0.001, call: { call: "NEUTRAL", kind }, plans: {
    breakout: { levels: { entry: 1000, stop: 980, t1: 1020, t2: 1040 } }, pullback: { levels: { entry: 1000, stop: 980, t1: 1020, t2: 1040 } } } });
  const b = nextPlan(d("breakout"), 100000, COSTS), p = nextPlan(d("pullback"), 100000, COSTS);
  assert.equal(p.shares, 100, "limit fill at 1000");
  assert.equal(b.shares, 99, "stop-buy fill at 1001");
  assert.ok(p.best > b.best, "paying slippage lowers the best case");
  assert.ok(p.best < 100 * 30 && p.best > 100 * 30 - 100, "half at 1020 and half at 1040, less charges");
});

test("stock badges use the company's initials", () => {
  assert.equal(monogram("TATASTEEL", "Tata Steel Ltd."), "TS");
  assert.equal(monogram("ITC", "ITC Ltd."), "IT");
  assert.equal(monogram("M&M", "Mahindra & Mahindra Ltd."), "MM");
  assert.equal(monogram("", ""), "?");
});

test("the Home page walks through the three steps with real data", { skip: !hasData() && "published data files are not present" }, async () => {
  install();
  const { renderHome } = await import("../js/home.js");
  const meta = readData("meta.json"), market = readData("market.json");
  const root = document.createElement("div");
  document.body.append(root);
  const went = [];
  await renderHome(root, { meta, market, params: new URLSearchParams({ s: "RELIANCE" }), go: (...a) => went.push(a) });
  const text = root.textContent;
  for (const phrase of ["Know the plan", "Choose a stock", "Next market day", "Last time", "How often we were right",
                        "Likely closing range", "Chance of a higher close", "a coin flip is 50%", "What each of the three plans did",
                        "up/down calls right from the opening price", "Educational only, not investment advice"]) assert.ok(text.includes(phrase), phrase);
  for (const banned of ["smart move", "Good setup", "leans down", "Buy only if"]) assert.ok(!text.includes(banned), `no "${banned}"`);
  assert.equal(root.querySelectorAll(".hx-tile").length, market.heatmap.length, "every stock can be chosen");
  assert.equal(root.querySelectorAll(".hx-tile.on").length, 1);
  assert.equal(root.querySelectorAll(".hx-card").length, 3);
  const compare = readData("compare.json"), lastRow = compare.stocks.RELIANCE.at(-1);
  const symbolFile = readData("symbols/RELIANCE.json");
  if (symbolFile.call.call === "NO_TRADE") {
    assert.ok(root.querySelector(".hx-fold"), "on a 'Wait' day the practice plan is folded away");
    assert.match(root.querySelector(".hx-fold").textContent, /See the practice plan \(for learning only\)/);
    assert.match(root.querySelector(".hx-fold").textContent, /The plan would buy only if/);
  }
  if (lastRow[compare.cols.indexOf("advice")] === "N") assert.match(text, /Our advice was Wait/, "a 'wait' day is judged as advice, not shown as ₹0 from a plan");
  assert.ok(root.querySelectorAll(".hx-dot").length >= 10, "a mark for each recent day");
  assert.ok(root.querySelectorAll(".hx-dot").every((x) => x.textContent === "✓" || x.textContent === "✗"), "not colour alone");
  assert.match(text, /Not proven|Test replay|Real prediction/);
  assert.ok(!/undefined|NaN|null/.test(text));

  // picking another stock redraws the three cards for it
  const other = root.querySelectorAll(".hx-tile").find((t) => t.dataset.sym === "TCS");
  other.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(other.classList.contains("on"));
  assert.match(root.querySelector(".hx-stock").textContent, /NSE: TCS/);

  // changing the amount changes the money
  const before = root.querySelector(".hx-money").textContent;
  root.querySelectorAll(".hx-chip").find((b) => b.textContent === "₹1,00,000").click();
  assert.notEqual(root.querySelector(".hx-money").textContent, before);
  assert.ok(!/undefined|NaN|null/.test(root.textContent));

  // search narrows the list
  root.querySelector(".hx-search").querySelector("input").dispatchEvent({ type: "input", target: { value: "infos" } });
  assert.deepEqual(root.querySelectorAll(".hx-tile").map((t) => t.dataset.sym), ["INFY"]);
});

test("Home does not choose a stock for a first-time visitor", { skip: !hasData() && "published data files are not present" }, async () => {
  install();                                                           // fresh storage: no remembered stock
  const { renderHome } = await import("../js/home.js?fresh");
  const root = document.createElement("div");
  await renderHome(root, { meta: readData("meta.json"), market: readData("market.json"), params: new URLSearchParams(), go() {} });
  assert.equal(root.querySelectorAll(".hx-tile.on").length, 0);
  assert.equal(root.querySelectorAll(".hx-card").length, 0);
  assert.match(root.textContent, /Pick any company above/);
  root.querySelectorAll(".hx-chip").find((b) => b.textContent === "INFY").click();     // a popular chip picks it
  await new Promise((r) => setTimeout(r, 30));
  assert.match(root.querySelector(".hx-stock").textContent, /NSE: INFY/);
});

test("Hindi strings are available and fall back to English", async () => {
  const { t, hasHindi } = await import("../js/i18n.js");
  assert.equal(t("Plans for {date}", { date: "23-Nov-2026" }), "Plans for 23-Nov-2026", "English by default");
  for (const key of ["Wait", "Likely closing range", "Educational only, not investment advice. Predictions can be wrong, and past results do not guarantee future ones. Every money figure is an estimate after typical trading charges."])
    assert.ok(hasHindi(key), key);
  assert.equal(t("a string with no translation"), "a string with no translation");
});
