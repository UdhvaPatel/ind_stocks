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
  assert.equal(called.kind, "breakout"); assert.equal(called.verdict.badge, "Maybe"); assert.equal(called.t2, 1050);
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

test("a 'wait' day is judged against what the plans would have done", () => {
  const day = (rules, advice = "N", kind = "gap_reversal") => pastRows({ days: ["2026-11-20"], track: ["live"], daily: [],
    stocks: { X: [[0, 100, -2, 0, 2, 101, 1, 0.5, 1, 1, kind, kind ? "not_triggered" : null, null, 98, 95, rules, advice]] } }, "X")[0];
  const saved = judgeWait(day([-1.2, -0.4, "n"]), 50000);
  assert.equal(saved.verdict, "saved"); assert.equal(saved.worst.kind, "breakout"); assert.equal(saved.worst.money, -600);
  const missed = judgeWait(day([0.8, "n", "n"]), 50000);
  assert.equal(missed.verdict, "missed"); assert.equal(missed.best.money, 400);
  assert.equal(judgeWait(day([0.8, -0.5, "n"]), 50000).verdict, "mixed");
  assert.equal(judgeWait(day(["n", "n", "n"]), 50000).verdict, "nothing");
  const partial = judgeWait(day([null, null, "n"]), 50000);
  assert.equal(partial.verdict, "nothing"); assert.equal(partial.partial, true, "says when some plans are not recorded");
  assert.equal(judgeWait(day([null, null, null], "N", null), 50000).verdict, "unknown");
  assert.equal(judgeWait(day([null, null, null]), 50000).verdict, "nothing", "the shown plan's own result is always known");
  assert.equal(judgeWait(day([0.8, -0.5, "n"], "U"), 50000), null, "only 'wait' days are judged this way");

  const R = record([day([-1.2, -0.4, "n"]), day([0.8, "n", "n"]), day(["n", "n", "n"]), day([0.5, null, "n"], "U")], 50000);
  assert.deepEqual([R.waits.days, R.waits.saved, R.waits.missed, R.waits.nothing], [3, 1, 1, 1]);
  assert.equal(R.waits.avoided, 600); assert.equal(R.waits.forgone, 400);

  const L = lastSession([day([-1.2, -0.4, "n"])], 50000);
  assert.equal(L.wait.verdict, "saved");
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
  for (const phrase of ["Know the plan", "Choose a stock", "Plan for the next market day", "If you had followed it last time",
                        "How often we were right", "Expected closing price", "Chance it closes higher", "What each plan would have done",
                        "Educational only, not investment advice"]) assert.ok(text.includes(phrase), phrase);
  assert.equal(root.querySelectorAll(".hx-tile").length, market.heatmap.length, "every stock can be chosen");
  assert.equal(root.querySelectorAll(".hx-tile.on").length, 1);
  assert.equal(root.querySelectorAll(".hx-card").length, 3);
  const compare = readData("compare.json"), lastRow = compare.stocks.RELIANCE.at(-1);
  if (lastRow[16] === "N") assert.match(text, /Our advice was Wait/, "a 'wait' day is judged as advice, not shown as ₹0 from a plan");
  assert.match(text, /When we said “wait”/);
  assert.ok(root.querySelectorAll(".hx-dot").length >= 10, "a dot for each recent day");
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
