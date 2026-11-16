// Regression test: switching to the "Breakout" or "Dip buy" what-if tab on the Today page
// used to leave both columns invisible. The redrawn cards carry the fade-in class `reveal`
// (opacity 0 until `in` is added), and the code asked the fade-in observer to watch a staging
// element the router had already emptied, so nothing ever became visible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasData, install, readData } from "./fakedom.mjs";

const env = install();
const { renderToday } = await import("../js/today.js");
const skip = !hasData() && "published data files are not present";

// Mirrors what app.js does: draw into a staging element, then move the result onto the page.
// (The page caches each symbol file, so a test that alters the data uses a different stock.)
async function show(symbolData, pick = 0) {
  const meta = readData("meta.json"), market = readData("market.json");
  const sym = market.heatmap[pick].symbol;
  const data = symbolData || readData(`symbols/${sym.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("symbols/") ? { ok: true, status: 200, json: async () => structuredClone(data) } : realFetch(url));
  const view = document.createElement("main");
  document.body.append(view);
  const holder = document.createElement("div");
  try {
    await renderToday(holder, { meta, market, params: new URLSearchParams({ s: sym }), go() {} });
  } finally { globalThis.fetch = realFetch; }
  view.append(...holder.childNodes.slice());
  view.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
  return { view, data };
}
const tab = (view, label) => view.querySelectorAll(".tab").find((b) => b.textContent.startsWith(label));
const hidden = (view) => view.querySelectorAll(".reveal").filter((el) => !el.classList.contains("in"));

for (const [label, kind] of [["Breakout", "breakout"], ["Dip buy", "pullback"], ["Gap reversal", "gap_reversal"]]) {
  test(`the ${label} what-if tab shows its cards`, { skip }, async () => {
    const { view, data } = await show();
    tab(view, label).click();
    env.flushObservers();                      // the browser reports on-page elements to the fade-in observer

    assert.equal(hidden(view).length, 0, "every redrawn card must become visible");
    const cols = view.querySelector(".desk").childNodes;
    assert.ok(cols[1].childNodes.length >= 3, "the main column is filled");
    assert.ok(cols[2].childNodes.length >= 1, "the ticket column is filled");
    assert.ok(tab(view, label).classList.contains("on"), "the clicked tab is marked as selected");
    const entry = data.plans[kind].levels.entry.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok(view.querySelector(".ifthen").textContent.includes(entry), "the ticket shows this rule's entry level");
    assert.ok(!/undefined|NaN/.test(view.textContent), "no undefined or NaN on the page");
  });
}

test("a rule with missing levels shows a message, not a blank page", { skip }, async () => {
  const market = readData("market.json");
  const data = readData(`symbols/${market.heatmap[1].symbol.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  data.plans.breakout = { kind: "breakout", levels: null };          // malformed publish
  delete data.rules.pullback;                                        // record missing for another rule
  const { view } = await show(data, 1);

  tab(view, "Breakout").click();
  env.flushObservers();
  const alert = view.querySelector("[role=alert]");
  assert.ok(alert, "an explanation is shown");
  assert.match(alert.textContent, /Breakout levels .* cannot be shown/);
  assert.equal(hidden(view).length, 0, "the explanation is visible");

  alert.querySelectorAll(".chip").find((b) => /dip buy/i.test(b.textContent)).click();   // and the way out works
  env.flushObservers();
  assert.equal(view.querySelector("[role=alert]"), null);
  assert.equal(hidden(view).length, 0);
  assert.ok(view.querySelector(".ifthen"), "the dip-buy ticket is drawn even though its record is missing");
  assert.ok(!/undefined|NaN/.test(view.textContent));
});
