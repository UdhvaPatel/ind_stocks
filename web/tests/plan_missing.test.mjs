// "Make a plan" when planner.json has not been published (its own file: the page caches data per process).
import assert from "node:assert/strict";
import { test } from "node:test";
import { install } from "./fakedom.mjs";

const COSTS = {
  brokerage: { pct_per_order: 0.0003, max_per_order: 20 }, stt_sell: 0.00025, exchange_txn: 0.0000297, sebi_fee: 0.000001,
  stamp_duty_buy: 0.00003, gst: 0.18, slippage: { stop_exit_multiplier: 1.5 }, reference: { capital: 100000, risk_pct: 1 },
};

test("the accuracy page explains itself when nothing is published", async () => {
  install({ "meta.json": { costs: COSTS }, "planner.json": null, "compare.json": null });
  const { renderAccuracy } = await import("../js/accuracy.js");
  const root = document.createElement("div");
  await renderAccuracy(root, { params: new URLSearchParams(), go() {} });
  assert.match(root.textContent, /No scored days have been published yet/);
});

test("the page explains itself when the planning file is missing", async () => {
  install({ "meta.json": { costs: COSTS }, "planner.json": null, "compare.json": null });
  const { renderPlan } = await import("../js/plan.js");
  const root = document.createElement("div");
  await renderPlan(root, { meta: { costs: COSTS, plan_for_date: "2026-11-16", plan_status: "draft" }, go() {} });
  assert.match(root.textContent, /has not been published yet/);
  assert.equal(root.querySelectorAll("input").length, 3, "the form is still drawn");

  const inputs = root.querySelectorAll("input");
  inputs[0].value = "100000"; inputs[1].value = "500"; inputs[2].value = "1";
  root.querySelector("form").dispatchEvent({ type: "submit", preventDefault() {} });
  assert.match(root.textContent, /nothing to size yet/i);
  assert.ok(!/undefined|NaN/.test(root.textContent));
});
