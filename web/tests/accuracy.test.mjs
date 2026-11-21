// "Accuracy check": forecast against the real close.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasData, install, readData } from "./fakedom.mjs";
import { allRows, marketSeries, stockSeries, summarize, verdict } from "../js/comparelogic.js";

// Three days for one stock. Previous close 100 each day; range -2%..+2%, most likely +0.1%.
const DATA = {
  days: ["2026-11-12", "2026-11-13", "2026-11-16"], track: ["backtest", "backtest", "live"],
  daily: [[0.6, 0.9, 0.5, 0.1, 50], [0.4, 0.8, 0.3, -0.5, 50], [0.42, 0.9, 0.62, 0.39, 50]],
  stocks: {
    AAA: [
      [0, 100, -2, 0.1, 2, 101, 1, 0.55, 1, 1],          // inside, lean up, rose: right
      [1, 100, -2, 0.1, 2, 96.5, -3.5, 0.6, 0, 0],       // fell below the range
      [2, 100, -2, 0.1, 2, 102.5, 2.5, 0.45, 0, 0],      // rose above the range, live
    ],
    BBB: [[2, 50, -1, 0, 1, 50.2, 0.4, 0.52, 1, 1], ["broken"], [9, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
  },
};

test("a stock's rows become rupee ranges and real closes, oldest first", () => {
  const rows = stockSeries(DATA, "AAA");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.date), DATA.days);
  assert.deepEqual([rows[0].lo, rows[0].hi], [98, 102]);
  assert.ok(Math.abs(rows[0].mid - 100.1) < 1e-9);
  assert.equal(rows[2].track, "live");
  assert.ok(Math.abs(rows[1].outsideBy - -1.5) < 1e-9, "fell 1.5% below the bottom of the range");
  assert.ok(Math.abs(rows[2].outsideBy - 0.5) < 1e-9);
  assert.equal(rows[0].outsideBy, 0);
  assert.equal(stockSeries(DATA, "BBB").length, 1, "broken rows are skipped");
  assert.equal(stockSeries(DATA, "AAA", "20").length, 3);
  assert.deepEqual(stockSeries(DATA, "AAA", "1").map((r) => r.date), ["2026-11-16"], "period keeps the most recent days");
  assert.deepEqual(stockSeries(DATA, "ZZZ"), []);
  assert.deepEqual(stockSeries(null, "AAA"), []);
});

test("the summary counts what landed inside and how often the lean was right", () => {
  const s = summarize(stockSeries(DATA, "AAA"));
  assert.equal(s.n, 3); assert.equal(s.live, 1); assert.equal(s.inside, 1);
  assert.ok(Math.abs(s.coverage - 1 / 3) < 1e-9);
  assert.equal(s.right, 1); assert.equal(s.dirN, 3);
  assert.ok(Math.abs(s.alwaysUp - 2 / 3) < 1e-9);
  assert.equal(s.above, 1); assert.equal(s.below, 1);
  assert.equal(s.biggest.date, "2026-11-13", "the biggest surprise is the furthest outside the range");
  assert.equal(s.insideStreak, 0);
  assert.ok(Math.abs(s.avgWidth - 4) < 1e-9);
  assert.equal(summarize([]), null);
});

test("the whole-market series follows the daily scores", () => {
  const m = marketSeries(DATA);
  assert.deepEqual(m.map((d) => d.coverage), [0.9, 0.8, 0.9]);
  assert.equal(m[2].track, "live");
  assert.equal(marketSeries(DATA, "2").length, 2);
  assert.equal(allRows(DATA).length, 4);
  assert.deepEqual(marketSeries({}), []);
});

test("the plain-words verdict reads the numbers honestly", () => {
  const few = verdict(summarize(stockSeries(DATA, "AAA")), "AAA");
  assert.equal(few.grade, "early");
  assert.match(few.range, /too little to judge/);
  assert.match(few.direction, /1 out of 3/);

  const mk = (n, inside, right, ups, days = 60) => ({ n, days, inside, coverage: inside / n, right, dirN: n, hit: right / n, alwaysUp: ups / n });
  const oneDay = verdict(mk(50, 45, 21, 31, 1), "X");                  // 50 stocks, but all from one session
  assert.equal(oneDay.grade, "early");
  assert.equal(oneDay.dirGrade, "early");
  assert.match(oneDay.range, /over 1 day\b/);
  assert.equal(verdict(mk(100, 90, 53, 50), "X").grade, "good");
  assert.equal(verdict(mk(100, 98, 53, 50), "X").grade, "wide");
  assert.equal(verdict(mk(100, 70, 53, 50), "X").grade, "narrow");
  assert.equal(verdict(mk(100, 90, 58, 50), "X").dirGrade, "good");
  assert.equal(verdict(mk(100, 90, 50, 50), "X").dirGrade, "even");
  const worse = verdict(mk(100, 90, 42, 62), "X");
  assert.equal(worse.dirGrade, "worse");
  assert.match(worse.direction, /guessing “up” every time would have been right 62%/);
  assert.match(verdict(mk(100, 90, 55, 30), "X").direction, /guessing “down”/);
  assert.equal(verdict(null).grade, "none");
  for (const v of [verdict(mk(100, 90, 58, 50)), worse]) assert.ok(!/guarantee|will be right/i.test(v.range + v.direction));
});

test("the page draws a stock chart, the day strip and a table, and switches to the whole market", async () => {
  install({ "compare.json": DATA });
  const { renderAccuracy } = await import("../js/accuracy.js");
  const root = document.createElement("div");
  document.body.append(root);
  const went = [];
  await renderAccuracy(root, { params: new URLSearchParams({ s: "AAA", p: "all", u: "inr" }), go: (...a) => went.push(a) });
  const text = root.textContent;
  for (const phrase of ["Prediction vs real market", "Blue bar = the prediction", "Green dot = landed inside", "Red dot = landed outside",
                        "AAA: what the tool predicted vs what really happened", "Day by day", "The last 15 days in numbers", "CLOSE INSIDE THE RANGE"]) assert.ok(text.includes(phrase), phrase);
  assert.equal(root.querySelectorAll(".hs").length, 3, "one square per day");
  assert.equal(root.querySelectorAll(".hs.in").length, 1);
  assert.equal(root.querySelectorAll(".hs.live").length, 1);
  const bodyRows = root.querySelector(".acc-tbl").querySelector("tbody").querySelectorAll("tr");
  assert.equal(bodyRows.length, 3);
  assert.match(bodyRows[0].textContent, /16-Nov-2026.*live.*₹98\.00 – ₹102\.00.*₹102\.50.*outside/, "newest first, in rupees");
  assert.ok(!/undefined|NaN/.test(text));
  root.querySelector(".hs").click();
  assert.deepEqual(went[0], ["archive", { date: "2026-11-12" }], "a day opens in the Archive");

  const select = root.querySelector(".acc-select");
  select.value = "ALL";
  select.dispatchEvent({ type: "change", target: select });
  const all = root.textContent;
  assert.ok(all.includes("Every day, all 50 stocks: how many predictions held?"));
  assert.ok(all.includes("Which stocks were predicted best?"));
  assert.ok(root.querySelector(".seg").querySelectorAll("button").every((b) => b.getAttribute("disabled") != null), "₹ / % does not apply to the whole market");
  assert.ok(!/undefined|NaN/.test(all));
});

test("the published comparison file matches the published day pages", { skip: !hasData() && "published data files are not present" }, () => {
  const data = readData("compare.json"), index = readData("days/index.json");
  assert.deepEqual(data.days, index.days.map((d) => d.date));
  const last = data.days[data.days.length - 1];
  const day = readData(`days/${last}/summary.json`);
  const rows = allRows(data, "1");
  assert.equal(rows.length, day.summary.scored);
  const s = summarize(rows);
  assert.ok(Math.abs(s.coverage - day.summary.coverage) < 0.011, "coverage agrees with the day page");
  assert.ok(Math.abs(s.hit - day.summary.dir_hit) < 0.011, "direction agrees with the day page");
});
