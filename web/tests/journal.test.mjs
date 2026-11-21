// Paper-trading journal: storage, scoring from published results, the page, and the Home button.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasData, install, readData } from "./fakedom.mjs";
import { add, entryId, has, load, remove, resolve, save, summary, toCSV } from "../js/journallogic.js";

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const COMPARE = {
  days: ["2026-11-19", "2026-11-20"], track: ["backtest", "live"], daily: [],
  stocks: {
    AAA: [[0, 100, -2, 0, 2, 101, 1, 0.5, 1, 1, "gap_reversal", "not_triggered", null, 98, 95, [1.2, -0.8, "n"], "N"],
          [1, 101, -2, 0, 2, 99, -2, 0.5, 1, 1, "breakout", "time", -0.6, 102, 100, [null, null, "n"], "U"]],
  },
};
const E = (o) => ({ symbol: "AAA", forDate: "2026-11-19", kind: "breakout", amount: 50000, ...o });

test("entries are stored, one per stock, day and plan, and survive bad storage", () => {
  const st = memory();
  let list = add(load(st), E());
  list = add(list, E());                                              // the same plan twice stays one entry
  list = add(list, E({ kind: "pullback" }));
  assert.equal(list.length, 2);
  assert.ok(save(list, st));
  assert.equal(load(st).length, 2);
  assert.ok(has(load(st), E()));
  assert.equal(remove(list, entryId(E())).length, 1);
  assert.throws(() => add([], E({ amount: 0 })), /cannot be added/);
  assert.throws(() => add([], E({ kind: "magic" })), /cannot be added/);
  assert.deepEqual(load({ getItem: () => "not json" }), []);
  assert.deepEqual(load({ getItem: () => { throw new Error("blocked"); } }), []);
  assert.equal(save([], { setItem: () => { throw new Error("full"); } }), false);
});

test("entries are scored from the published results", () => {
  const list = [E(), E({ kind: "pullback" }), E({ kind: "gap_reversal" }), E({ forDate: "2026-11-20" }),
                E({ forDate: "2026-11-20", kind: "pullback" }), E({ forDate: "2026-11-23" }), E({ forDate: "2026-11-18" }), E({ symbol: "ZZZ" })];
  const r = resolve(list, COMPARE);
  assert.deepEqual(r.map((e) => [e.status, e.money]), [
    ["gain", 600],          // breakout +1.2% of 50,000
    ["loss", -400],         // dip buy −0.8%
    ["no_trade", 0],        // never triggered
    ["loss", -300],         // not in the per-rule list, but it was the plan shown that day: −0.6%
    ["unknown", null],      // scored day, result not recorded
    ["pending", null],      // the session has not happened yet
    ["no_data", null],      // before the published history
    ["no_data", null],      // stock not in the file
  ]);
  const s = summary(r);
  assert.deepEqual([s.entries, s.trades, s.wins, s.losses, s.pending, s.noTrade, s.unknown], [8, 3, 1, 2, 1, 1, 3]);
  assert.equal(s.total, -100);
  assert.ok(Math.abs(s.avgReturnPct - (-100 / 150000) * 100) < 1e-9);
  assert.deepEqual(s.curve, [["2026-11-19", 600], ["2026-11-19", 200], ["2026-11-20", -100]]);
  const csv = toCSV(r);
  assert.match(csv.split("\n")[0], /^session,stock,plan,amount_rs,status,result_rs/);
  assert.match(csv, /2026-11-19,AAA,breakout,50000,gain,600\.00,1\.2,/);
  assert.equal(summary(resolve([], COMPARE)).trades, 0);
  assert.equal(resolve([E()], null)[0].status, "pending");
});

test("the journal page: empty state, then results, remove and two-step clear", async () => {
  install({ "compare.json": COMPARE });
  const { renderJournal } = await import("../js/journal.js");
  const went = [];
  const root = document.createElement("div");
  document.body.append(root);
  await renderJournal(root, { go: (...a) => went.push(a) });
  assert.match(root.textContent, /Your journal is empty/);
  root.querySelectorAll("button").find((b) => /Go to Home/.test(b.textContent)).click();
  assert.deepEqual(went[0], ["home"]);

  save([E(), E({ kind: "pullback" }), E({ forDate: "2026-11-23" })].reduce((l, e) => add(l, e), []));
  await renderJournal(root, { go() {} });
  const text = root.textContent;
  assert.match(text, /RESULT SO FAR/);
  assert.match(text, /\+₹200/, "600 − 400");
  assert.match(text, /Waiting for the result/);
  assert.equal(root.querySelectorAll(".jr-row").length, 3);
  assert.ok(!/undefined|NaN/.test(text));

  root.querySelector(".jr-x").click();                                // remove the newest (pending) one
  assert.equal(root.querySelectorAll(".jr-row").length, 2);
  const clearBtn = () => root.querySelectorAll("button").find((b) => /Clear journal|Press again/.test(b.textContent));
  clearBtn().click();
  assert.equal(root.querySelectorAll(".jr-row").length, 2, "the first press only asks for confirmation");
  clearBtn().click();
  assert.match(root.textContent, /Your journal is empty/);
});

test("Home: 'Practise with pretend money' adds to the journal and can be undone", { skip: !hasData() && "published data files are not present" }, async () => {
  install();
  const { renderHome } = await import("../js/home.js");
  const meta = readData("meta.json"), market = readData("market.json");
  const root = document.createElement("div");
  document.body.append(root);
  const went = [];
  // pick a stock whose plan fits the default amount
  await renderHome(root, { meta, market, params: new URLSearchParams({ s: "ITC" }), go: (...a) => went.push(a) });
  const follow = root.querySelectorAll("button").find((b) => /Practise with pretend money/.test(b.textContent));
  assert.ok(follow, "the button is offered");
  follow.click();
  assert.equal(load().length, 1);
  assert.equal(load()[0].symbol, "ITC");
  assert.equal(load()[0].forDate, meta.plan_for_date);
  assert.match(root.textContent, /In your paper-trading journal/);
  root.querySelectorAll("button").find((b) => b.textContent === "Open journal").click();
  assert.deepEqual(went.at(-1), ["journal"]);
  root.querySelectorAll("button").find((b) => b.textContent === "Undo").click();
  assert.equal(load().length, 0);
  assert.match(root.textContent, /Honest research/);
});

test("How it works shows the research table", { skip: !hasData() && "published data files are not present" }, async () => {
  install();
  const { renderHow } = await import("../js/how.js");
  const meta = readData("meta.json"), research = readData("research.json");
  const root = document.createElement("div");
  await renderHow(root, { meta });
  assert.match(root.textContent, /Is there a trading rule that beats the market\? Our test/);
  assert.equal(root.querySelector(".rs-tbl").querySelector("tbody").querySelectorAll("tr").length, research.variants_tested);
  assert.ok(!/undefined|NaN/.test(root.textContent));
});
