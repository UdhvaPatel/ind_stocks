// Plain-language summaries and the extra statistics, plus the newcomer pieces of the pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasData, install, readData } from "./fakedom.mjs";
import { marketStats, planStats, plainWords, ruleTable } from "../js/insight.js";

const row = (symbol, change_pct, extra = {}) => ({ symbol, close: 100, change_pct, health: 60, call: "NO_TRADE", atr_pct: 2, p_up: 0.5, ...extra });

test("market statistics count and average the published rows", () => {
  const m = marketStats([row("A", 2, { p_up: 0.6, call: "NEUTRAL" }), row("B", -1, { p_up: 0.4 }), row("C", 0), row("D", 4, { call: "FAVOURABLE", health: 80 }),
                         row("E", -3), row("F", null, { p_up: null })]);
  assert.equal(m.count, 6);
  assert.deepEqual([m.advancers, m.decliners, m.unchanged], [2, 2, 1]);
  assert.equal(m.avgChange, 0.4);
  assert.equal(m.medianChange, 0);
  assert.equal(m.biggestMove, 4);
  assert.deepEqual(m.gainers.map((r) => r.symbol), ["D", "A"]);
  assert.deepEqual(m.losers.map((r) => r.symbol), ["E", "B"]);
  assert.deepEqual([m.leanUp, m.leanDown], [1, 1]);
  assert.deepEqual(m.calls, { FAVOURABLE: 1, NEUTRAL: 1, NO_TRADE: 4 });
  assert.equal(m.withPlan, 2);
  assert.equal(m.mood, "mixed");
  assert.equal(marketStats([row("A", 1), row("B", 2), row("C", 3)]).mood, "broadly up");
});

test("market statistics cope with nothing to count", () => {
  for (const rows of [null, [], [{}]]) {
    const m = marketStats(rows);
    assert.equal(m.count, 0);
    assert.equal(m.avgChange, null);
    assert.equal(m.mood, "unknown");
    assert.deepEqual(m.gainers, []);
  }
});

test("the plain-words verdict matches the tool's call and never tells anyone to buy", () => {
  const base = { last: { close: 200, change_pct: -1, volume_ratio: 0.6 }, atr: 4, atr_pct: 2, health: { score: 75 },
                 claims: { dir: { p_up: 0.47 }, close: { p05: -2, p95: 3 }, range: { p50: 1.8, p90: 3 } }, forecast: { n: 140 } };
  const tones = {};
  for (const call of ["NO_TRADE", "NEUTRAL", "FAVOURABLE"]) {
    const p = plainWords({ ...base, call: { call } });
    tones[call] = p.tone;
    assert.ok(p.headline.length > 10 && p.text.length > 40);
    assert.ok(!/\b(buy now|you should buy|guaranteed|sure thing)\b/i.test(p.headline + p.text));
    assert.deepEqual(p.facts.map((f) => f.key), ["close", "swing", "up", "range", "hilo", "volume", "health", "similar"]);
  }
  assert.deepEqual(tones, { NO_TRADE: "idle", NEUTRAL: "maybe", FAVOURABLE: "good" });
  const p = plainWords({ ...base, call: { call: "NO_TRADE" } });
  assert.match(p.headline, /Nothing to do/);
  const f = Object.fromEntries(p.facts.map((x) => [x.key, x]));
  assert.deepEqual(f.range.value, { kind: "range", lo: 196, hi: 206 });
  assert.equal(f.up.note.text, "close to a coin flip");
  assert.equal(f.volume.note.text, "quieter than usual");
  assert.match(f.health.note.text, /does not predict/);
});

test("plain words still work when most of the data is missing", () => {
  for (const d of [null, {}, { call: {} }, { call: { call: "SOMETHING_NEW" }, last: {} }]) {
    const p = plainWords(d);
    assert.equal(p.tone, "idle");
    assert.deepEqual(p.facts, []);
  }
});

test("the rule table lines up the three rules with shares of past trades", () => {
  const d = { call: { call: "NEUTRAL", kind: "gap_reversal" },
    plans: { breakout: { levels: { p_trigger: 0.4 } }, gap_reversal: { levels: { p_trigger: 0.03 } }, pullback: null },
    rules: { breakout: { trades: 200, win_rate: 0.4, expectancy_r: -0.1, longest_losing_streak: 9, outcomes: { stopped: 50, t1: 30, t2: 10, time: 110 } } } };
  const t = ruleTable(d);
  assert.deepEqual(t.map((r) => r.kind), ["breakout", "gap_reversal", "pullback"]);
  assert.equal(t[0].stoppedShare, 0.25);
  assert.equal(t[0].targetShare, 0.2);
  assert.equal(t[0].called, false);
  assert.equal(t[1].called, true);
  assert.equal(t[1].trades, 0);
  assert.equal(t[1].winRate, null);
  assert.equal(t[2].pTrigger, null);
  assert.deepEqual(ruleTable({}), []);
});

test("plan statistics summarise only plans that hold shares", () => {
  const s = planStats([
    { shares: 10, value: 1000, bestGain: 60, lossAtStop: 30, pTarget: 0.1, pTrigger: 0.4, expectedRs: -2 },
    { shares: 5, value: 3000, bestGain: 90, lossAtStop: 60, pTarget: null, pBest: 0.02, pTrigger: 0.2, expectedRs: -4 },
    { shares: 0, value: 0, bestGain: 0, lossAtStop: 0 },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.bestChance, 0.1);
  assert.equal(s.biggestGain, 90);
  assert.equal(s.smallestLoss, 30);
  assert.equal(s.avgPosition, 2000);
  assert.equal(s.avgRewardRisk, 1.75);
  assert.ok(Math.abs(s.avgTrigger - 0.3) < 1e-12);
  assert.equal(s.expectedTotal, -3);
  assert.equal(planStats([]), null);
  assert.equal(planStats(null), null);
});

// ------------------------------------------------------------ on the pages
const skip = !hasData() && "published data files are not present";

test("the Today page explains itself: plain words, rule table and market summary", { skip }, async () => {
  install();
  const { renderToday } = await import("../js/today.js");
  const meta = readData("meta.json"), market = readData("market.json");
  const root = document.createElement("div");
  document.body.append(root);
  const went = [];
  await renderToday(root, { meta, market, params: new URLSearchParams({ s: market.heatmap[2].symbol }), go: (...a) => went.push(a) });
  const text = root.textContent;
  for (const phrase of ["In plain words", "The three rules, side by side", "The market at a glance", "A normal day's swing",
                        "Chance it closes higher next session", "Biggest rises", "Biggest falls", "STOCKS WITH A PLAN"]) assert.ok(text.includes(phrase), phrase);
  assert.ok(root.querySelector(".light"), "a traffic-light verdict is drawn");
  assert.ok(root.querySelectorAll(".fact").length >= 6);
  assert.equal(root.querySelectorAll(".rrow").length, 3);
  assert.ok(!/undefined|NaN|null/.test(text));

  root.querySelectorAll(".rrow")[0].click();                           // a table row switches the rule shown
  assert.ok(root.querySelectorAll(".rrow")[0].classList.contains("on"));
  root.querySelector(".mover").click();                                // a mover opens that stock
  assert.equal(went[0][0], "today");
  assert.ok(market.heatmap.some((r) => r.symbol === went[0][1].s));
});

test("the welcome card can be dismissed for good, and the help panel explains the words", async () => {
  install();
  const { GLOSSARY, STEPS, closeHelp, openHelp, simpleNote, skeleton, welcomeCard } = await import("../js/guide.js");
  const went = [];
  const go = (...a) => went.push(a);

  const card = welcomeCard(go);
  assert.equal(card.querySelector(".welcome-steps").querySelectorAll("li").length, STEPS.length);
  assert.match(card.textContent, /does not tell you what to buy/);
  card.querySelectorAll("button").find((b) => /Make a plan/.test(b.textContent)).click();
  assert.deepEqual(went[0], ["plan"]);
  card.querySelectorAll("button").find((b) => b.textContent === "Got it").click();
  assert.equal(welcomeCard(go), null, "it stays hidden once dismissed");

  openHelp(go);
  const help = document.body.querySelector(".help");
  assert.ok(help && help.getAttribute("role") === "dialog");
  assert.equal(help.querySelectorAll(".gloss-row").length, GLOSSARY.length);
  for (const word of ["Stop", "Target", "No trade", "After costs"]) assert.ok(help.textContent.includes(word), word);
  help.querySelector(".help-search").dispatchEvent({ type: "input", target: { value: "give-up" } });
  assert.equal(help.querySelectorAll(".gloss-row").length, 1, "the glossary can be searched");
  help.querySelectorAll("button").find((b) => /welcome card again/.test(b.textContent)).click();
  assert.equal(document.body.querySelector(".help"), null);
  assert.ok(welcomeCard(go), "the welcome card can be brought back");
  closeHelp();                                                         // closing twice is harmless

  assert.match(simpleNote("track", go).textContent, /In simple words/);
  assert.equal(simpleNote("today", go), null);
  for (const route of ["today", "plan", "track", "archive", "how", "other"]) assert.ok(skeleton(route).querySelectorAll(".sk").length >= 6, route);
});
