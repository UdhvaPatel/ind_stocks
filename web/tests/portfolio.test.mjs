// Desk paper portfolio page, its Home banner, and the range-study card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { install } from "./fakedom.mjs";

const day = (date, pnl, verified = true, trades = 1) => ({ date, verified, reserved: 25000, deployed: trades ? 25010 : 0, pnl, charges: 30, trades, wins: pnl > 0 ? 1 : 0,
  positions: trades ? [{ symbol: "INFY", kind: "gap_reversal", shares: 20, entry: 1200, status: pnl > 0 ? "t2" : "stopped", pnl }] : [] });
const totals = (days) => { const v = days.filter((d) => d.verified); return { sessions: v.length, pnl: v.reduce((a, d) => a + d.pnl, 0), deployed: v.reduce((a, d) => a + d.deployed, 0),
  trades: v.reduce((a, d) => a + d.trades, 0), wins: v.reduce((a, d) => a + d.wins, 0), idle_sessions: v.filter((d) => !d.trades).length }; };
const deskDays = [day("2026-11-23", -320), day("2026-11-24", 0, true, 0), day("2026-11-25", 410), day("2026-11-26", 999, false)];
const P = { portfolio_version: "1.0.0", first_day: "2026-11-23", capital: 100000, risk_per_trade: 500, max_positions: 4, min_days_for_verdict: 60,
  books: { desk: { label: "Dalal Desk portfolio", days: deskDays, totals: totals(deskDays) }, practice: { label: "Practice book", note: "not the call", days: [], totals: totals([]) } },
  benchmarks: { every_plan: { days: deskDays.map((d) => ({ date: d.date, pnl: -200 })), totals: { pnl: -600 } }, nifty_day: { days: deskDays.map((d) => ({ date: d.date, pnl: 50 })), pnl: 150 },
    nifty_hold: { days: [{ date: "2026-11-25", value: 700 }] } },
  replay: { label: "Test replay (not live)", days: [{ date: "2026-11-19", pnl: 120, trades: 1, wins: 1 }, { date: "2026-11-20", pnl: 0, trades: 0, wins: 0 }],
    totals: { sessions: 2, pnl: 120, trades: 1, wins: 1, idle_sessions: 1 }, nifty_day: [], note: "replayed" }, allocator: null };

test("the portfolio page leads with the verified result and never counts unverified sessions", async () => {
  install({ "portfolio.json": P });
  const { renderPortfolio, portfolioHeadline } = await import("../js/portfolio.js");
  const root = document.createElement("div");
  await renderPortfolio(root, { go() {} });
  const text = root.textContent;
  assert.match(text, /As Dalal Desk, with pretend money/);
  assert.match(text, /over 3 verified sessions/, "the unverified 26 Nov is left out");
  assert.match(text, /Only 3 of 60 verified sessions so far/);
  for (const label of ["DOING NOTHING", "EVERY PLAN", "NIFTY 50 DAY-TRADED", "Every session", "The weekly learning model (shadow)", "Test replay", "The rules, fixed in advance"])
    assert.ok(text.includes(label), label);
  assert.match(text, /not proven/);
  assert.ok(!/undefined|NaN/.test(text));
  assert.ok(!/\bbuy now\b|you should/i.test(text), "never reads as a tip");

  const b = portfolioHeadline(P);
  assert.match(b.text, /pretend money, not advice/);
  assert.match(b.text, /3 verified sessions/);
  assert.match(b.text, /\+₹90/);
  assert.equal(b.tone, "up");
  const empty = portfolioHeadline({ ...P, books: { desk: { days: [], totals: totals([]) } } });
  assert.match(empty.text, /starts Mon, 23-Nov-2026/);
  assert.equal(portfolioHeadline(null), null);
});

test("the range-study card shows the decision and never promises shrinking ranges", async () => {
  install({ "compare.json": { layout: 2, cols: ["day"], days: ["2026-11-20"], track: ["backtest"], daily: [[0.5, 0.9, 0.5, 0, 50, 0.5]], stocks: {} },
            "range_study.json": { ready: false, decision: "keep the current range: only 0 of 40 verified live sessions so far", rule: "fixed rule",
              current: { coverage: 0.8675, avg_width: 5.05, score: 7.88 }, challenger: { coverage: 0.894, avg_width: 5.79, score: 8.11 } } });
  const { renderAccuracy } = await import("../js/accuracy.js?range");
  const root = document.createElement("div");
  await renderAccuracy(root, { params: new URLSearchParams(), go() {} });
  const text = root.textContent;
  assert.match(text, /Will the range get narrower\?/);
  assert.match(text, /keep current range/);
  assert.match(text, /86\.8%/);
  assert.match(text, /not expected to shrink steadily week by week/);
});
