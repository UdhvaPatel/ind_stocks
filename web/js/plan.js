// "Make a plan" page: three inputs, a feasibility check, and sized plans or alternatives.
// The arithmetic is in planlogic.js; this file only draws.
import { clear, countUp, dir, fmt, fmtDate, getJSON, h, icon, istNow, ok, prefs } from "./core.js";
import { openHelp } from "./guide.js";
import { planStats } from "./insight.js";
import { makePlan } from "./planlogic.js";

const CALL_TEXT = { NO_TRADE: "NO TRADE", NEUTRAL: "NEUTRAL", FAVOURABLE: "FAVOURABLE" };
const px = (x) => "₹" + fmt.px(x);
const chance = (p, bound) => (p == null ? "not known" : (bound === "under" ? "under " : "about ") + (p > 0 && p < 0.005 ? "0.5%" : fmt.prob(p, p < 0.1 ? 1 : 0)));

export async function renderPlan(root, ctx) {
  const { meta, go } = ctx;
  const planner = await getJSON("planner.json", { optional: true });
  const saved = prefs.get("plan-inputs", null) || {};
  const state = { amount: saved.amount ?? meta.costs.reference.capital, target: saved.target ?? "", risk: saved.risk ?? meta.costs.reference.risk_pct };

  clear(root);
  const forDate = (planner && planner.for_date) || meta.plan_for_date;
  const status = { scored: "committed before the open", draft: "draft levels; the scored plan is committed at about 06:00 IST", not_issued: "no plan was issued" }[(planner && planner.plan_status) || meta.plan_status] || "";
  const results = h("div", { class: "stack", "aria-live": "polite" });

  const inputs = {}, errs = {};
  const field = (key, label, hint, prefix, suffix, attrs) => {
    inputs[key] = h("input", { id: "p-" + key, type: "number", inputmode: "decimal", value: state[key], "aria-describedby": `p-${key}-hint p-${key}-err`, ...attrs });
    errs[key] = h("div", { class: "field-err", id: `p-${key}-err`, role: "alert" });
    return h("div", { class: "field" },
      h("label", { for: "p-" + key, text: label }),
      h("div", { class: "inp" }, prefix ? h("span", { text: prefix }) : null, inputs[key], suffix ? h("span", { text: suffix }) : null),
      h("div", { class: "field-hint", id: `p-${key}-hint`, text: hint }), errs[key]);
  };

  const run = () => {
    const raw = { amount: inputs.amount.value, target: inputs.target.value, risk: inputs.risk.value };
    let res;
    try { res = makePlan(planner, meta.costs, raw); }
    catch (err) { clear(results).append(note("bad", "The plan could not be worked out.", [String(err.message || err)])); return; }
    for (const k of Object.keys(inputs)) {
      const msg = res.errors[k] || "";
      errs[k].textContent = msg;
      inputs[k].setAttribute("aria-invalid", msg ? "true" : "false");
      inputs[k].closest(".field").classList.toggle("bad", !!msg);
    }
    if (res.status === "invalid") {
      clear(results).append(note("bad", "Some values need fixing before a plan can be made.", Object.values(res.errors)));
      (inputs[Object.keys(res.errors)[0]] || inputs.amount).focus();
      return;
    }
    prefs.set("plan-inputs", res.inputs);
    clear(results).append(...resultView(res, { go, apply: (vals) => { for (const k of Object.keys(inputs)) inputs[k].value = vals[k]; run(); } }));
  };

  const form = h("form", { class: "card-b planform", novalidate: true, onsubmit: (e) => { e.preventDefault(); run(); } },
    h("div", { class: "planfields" },
      field("amount", "INVESTMENT AMOUNT", "Money you would put into one position.", "₹", null, { min: 0, step: 1000 }),
      field("target", "TARGET EARNINGS FOR THE DAY", `What you would like to earn on ${fmtDate(forDate)}, after charges.`, "₹", null, { min: 0, step: 100, placeholder: "e.g. 500" }),
      field("risk", "RISK TOLERANCE", "The most of that amount you could accept losing on the day.", null, "%", { min: 0, max: 100, step: 0.1 })),
    h("div", { class: "planact" },
      h("button", { class: "btn primary", type: "submit", text: "Make a plan" }),
      h("span", { class: "muted small", text: "Nothing you type leaves your browser." })),
    h("div", { class: "tryrow" }, h("span", { class: "muted small", text: "Not sure what to type? Try one:" }),
      [["A careful start", 100000, 500, 1], ["A small amount", 5000, 100, 2], ["An ambitious goal", 100000, 5000, 1]].map(([label, a, t, r]) =>
        h("button", { class: "chip", type: "button", text: `${label}: ${fmt.rs(a)}, earn ${fmt.rs(t)}, risk ${r}%`, onclick: () => { inputs.amount.value = a; inputs.target.value = t; inputs.risk.value = r; run(); } })),
      h("button", { class: "linkish", type: "button", text: "Words explained", onclick: () => openHelp(go) })));

  const today = istNow().date;
  root.append(h("div", { class: "stack planpage" },
    h("section", { class: "card" },
      h("div", { class: "card-h" }, h("h3", { text: `Make a plan for ${fmtDate(forDate, true)}` }), h("span", { class: "hint", text: status })),
      h("div", { class: "card-b", style: { paddingBottom: "0" } },
        h("p", { class: "plan-lede", text: "Say how much you would invest, what you would like to earn that day, and how much you could accept losing. The page checks whether those three fit together, using the levels and the measured record already published for that session. It estimates; it does not promise." }),
        !planner ? h("div", { class: "banner-warn", text: "The planning data for this session has not been published yet. It appears with the next scheduled update." }) : null,
        forDate < today ? h("div", { class: "banner-warn", text: `These levels were made for ${fmtDate(forDate, true)}, which has passed. They are shown for study only until the next update.` }) : null),
      form),
    results));
  if (planner && saved.target) run();
}

// ----------------------------------------------------------------- pieces
function note(tone, title, lines) {
  return h("section", { class: "card planverdict " + tone },
    h("div", { class: "card-b" },
      h("div", { class: "pv-title" }, h("span", { class: "pill " + (tone === "ok" ? "amber" : "bad"), text: tone === "ok" ? "POSSIBLE, NOT PROMISED" : tone === "bad" ? "NOT COMPATIBLE" : "NOTE" }), h("b", { text: title })),
      lines.length ? h("ul", { class: "pv-list" }, lines.map((t) => h("li", { text: t }))) : null));
}

function resultView(res, hooks) {
  const { amount, target, risk } = res.inputs, out = [];
  const caution = h("p", { class: "muted small", text: "Estimates come from how these rules behaved on past sessions, after charges and typical slippage. News, results dates and order-book depth are not modelled. Past behaviour does not guarantee future results; any of these can lose money." });

  if (res.status === "no_data") { out.push(note("bad", "There is nothing to size yet.", res.reasons)); return out; }

  if (res.status === "feasible") {
    const s = res.summary, lines = [];
    lines.push(`${s.stocksMeeting} of today's stock levels could reach ${fmt.rs(target)} in their best case with ${fmt.rs(amount)}, while keeping the loss at the stop within ${fmt.rs((amount * risk) / 100)} (${risk}%).`);
    if (s.chanceHi != null) lines.push(s.chanceHi < 0.005
      ? "On past sessions like this one, earning that much or more was rare: under 1 day in 200 on each plan shown."
      : `On past sessions like this one, a plan shown here earned that much or more on roughly ${fmt.prob(s.chanceLo, 1)} to ${fmt.prob(s.chanceHi, 1)} of days. On most days it did not trigger or earned less.`);
    if (s.negativeRecord) lines.push(s.negativeRecord === s.shown
      ? "Every rule shown has lost money on average after costs in testing. Reaching the target is possible, not expected."
      : `${s.negativeRecord} of the ${s.shown} rules shown have lost money on average after costs in testing.`);
    if (s.fewerThanMin) lines.push(`Only ${s.shown} ${s.shown === 1 ? "stock fits" : "stocks fit"} these numbers today, so fewer than four plans are shown.`);
    out.push(note("ok", "These numbers fit together in the best case.", lines));
    out.push(planGrid(res.plans, res, hooks, `${res.plans.length} separate plans, one stock each`, "Each uses the full amount on its own. They are alternatives to compare, not a basket to buy together."));
  } else {
    out.push(note("bad", `${fmt.rs(amount)}, a ${fmt.rs(target)} target and ${risk}% risk do not fit together.`, res.reasons));
    if (res.alternatives.length) {
      out.push(h("section", { class: "card" },
        h("div", { class: "card-h" }, h("h3", { text: "What the estimates do support" }), h("span", { class: "hint", text: "Pick one to see its plans" })),
        h("div", { class: "card-b altgrid" }, res.alternatives.map((a) => h("div", { class: "alt" },
          h("b", { text: a.title }), h("p", { text: a.text }),
          h("p", { class: "muted small", text: `Chance of that best case on a session like this: ${chance(a.chance)}. An estimate from history, not a promise.` }),
          h("button", { class: "btn", type: "button", text: "Use these numbers", onclick: () => hooks.apply(a.apply) }))))));
    }
    if (res.plans.length) out.push(planGrid(res.plans, res, hooks, "Closest plans within your amount and risk limit",
      `None reaches ${fmt.rs(target)}; the best case of each is shown.`));
  }
  out.push(caution);
  return out;
}

function planGrid(plans, res, hooks, title, hint) {
  return h("section", { class: "card" },
    h("div", { class: "card-h" }, h("h3", { text: title }), h("span", { class: "hint", text: hint })),
    statsRow(plans),
    h("div", { class: "card-b pgrid" }, plans.map((p) => planCard(p, res, hooks))));
}

// Numbers across all the plans shown, so they can be compared at a glance.
function statsRow(plans) {
  const s = planStats(plans);
  if (!s) return null;
  const tile = (label, to, format, note, cls) => {
    const v = h("div", { class: "sv " + (cls || "") });
    countUp(v, to, format, 700);
    return h("div", { class: "stat" }, h("div", { class: "sl", text: label }), v, h("div", { class: "sn", text: note }));
  };
  return h("div", { class: "card-b ctx", style: { paddingBottom: "0" } },
    tile("PLANS SHOWN", s.count, (v) => fmt.int(Math.round(v)), "one stock each"),
    tile("BEST CHANCE", ok(s.bestChance) ? s.bestChance * 100 : null, (v) => fmt.pct0(v, 1), "of reaching the goal, on any one plan"),
    tile("LARGEST BEST CASE", s.biggestGain, (v) => fmt.signedRs(v), "if every target is reached", "up"),
    tile("SMALLEST LOSS AT STOP", -s.smallestLoss, (v) => fmt.signedRs(v), "the least any plan risks", "down"),
    tile("REWARD FOR EACH ₹1 RISKED", s.avgRewardRisk, (v) => "₹" + fmt.num(v, 2), "best case, on average"),
    tile("CHANCE A PLAN TRIGGERS", ok(s.avgTrigger) ? s.avgTrigger * 100 : null, (v) => fmt.pct0(v, 0), "on average; otherwise nothing is bought"),
    tile("AVERAGE POSITION", s.avgPosition, (v) => fmt.rs(v), "money actually put in"),
    tile("AVERAGE EXPECTED RESULT", s.expectedTotal, (v) => fmt.signedRs(v), "what history suggests per plan, per day", dir(s.expectedTotal)));
}

function planCard(p, res, hooks) {
  const gap = p.kind === "gap_reversal";
  const buy = gap
    ? `Only if the stock opens at or below ${px(p.entry)}${p.floor != null ? ` (and not below ${px(p.floor)})` : ""}: this plan would buy ${fmt.int(p.shares)} shares at the 09:15 IST open.`
    : `Only if the price ${p.kind === "breakout" ? "trades through" : "dips through"} ${px(p.entry)} before ${p.cancelAfter} IST: this plan would buy ${fmt.int(p.shares)} shares. Otherwise nothing is bought.`;
  const sell = gap
    ? `Sell everything at ${px(p.t1)} (yesterday's close), or at the stop near ${px(p.stop)}, or at ${p.exitBy} IST, whichever comes first.`
    : `Sell half at ${px(p.t1)} and the rest at ${px(p.t2)}; sell everything at the stop ${px(p.stop)}, or at ${p.exitBy} IST, whichever comes first.`;
  const record = p.expectancyR == null ? "no history"
    : `${fmt.r(p.expectancyR)} a trade over ${fmt.int(p.trades)} trades${p.winRate != null ? `, ${fmt.prob(p.winRate)} won` : ""}${p.enough ? "" : " (few trades)"}`;
  const meets = p.bestGain >= res.inputs.target;
  return h("article", { class: "pcard" + (p.called ? " called" : "") },
    h("div", { class: "pc-head" },
      h("div", {}, h("div", { class: "eyebrow", text: `NSE: ${p.symbol}` }), h("div", { class: "pc-name", text: p.name })),
      h("span", { class: "tag", text: p.ruleName })),
    h("div", { class: "pc-call" },
      h("span", { class: "call " + p.call }, icon(p.call === "FAVOURABLE" ? "check" : p.call === "NEUTRAL" ? "minus" : "pause"), CALL_TEXT[p.call] || p.call),
      h("span", { class: "muted small", text: p.called ? "the tool's own call for this session" : `the tool's call is ${p.callLabel || "no trade"}; levels are a what-if` })),
    h("div", { class: "sig" }, h("span", { class: "sig-k buy", text: "BUY SIGNAL" }), h("p", { text: buy })),
    h("div", { class: "sig" }, h("span", { class: "sig-k sell", text: "SELL SIGNAL" }), h("p", { text: sell })),
    h("div", { class: "rr", role: "img", "aria-label": `Could lose ${fmt.rs(p.lossAtStop)} at the stop; could gain ${fmt.rs(p.bestGain)} in the best case` },
      h("div", { class: "rr-bar" }, h("i", { class: "d", style: { flexGrow: Math.max(1, Math.round(p.lossAtStop)) } }), h("i", { class: "u", style: { flexGrow: Math.max(1, Math.round(p.bestGain)) } })),
      h("div", { class: "rr-l" }, h("span", { class: "down", text: `risk ${fmt.rs(p.lossAtStop)}` }), h("span", { class: "up", text: `best case ${fmt.rs(p.bestGain)}` }))),
    h("div", { class: "odds" },
      h("div", { class: "odds-l" }, h("span", { text: meets ? "Chance of reaching your goal" : "Chance of the best case" }), h("b", { text: chance(meets ? p.pTarget : p.pBest, meets ? p.pTargetBound : null) })),
      h("div", { class: "mbar accent" }, h("i", { vars: { "--v": Math.max(0.01, Math.min(1, (meets ? p.pTarget : p.pBest) || 0)) } }))),
    h("dl", { class: "kv" },
      h("dt", { text: "Position" }), h("dd", { text: `${fmt.int(p.shares)} shares · ${fmt.rs(p.value)}` }),
      h("dt", { text: "Holding period" }), h("dd", { text: gap ? `09:15 to ${p.exitBy} IST at most` : `same session, out by ${p.exitBy} IST` }),
      h("div", { class: "sep" }),
      h("dt", { text: "Estimated best case" }), h("dd", { class: "up", text: `${fmt.signedRs(p.bestGain)} (${fmt.pct(p.bestGainPct, 1)})` }),
      h("dt", { text: "Loss if the stop is hit" }), h("dd", { class: "down", text: `${fmt.signedRs(-p.lossAtStop)} (${fmt.pct0(p.lossPct, 1)} of amount)` }),
      h("dt", { text: "Typical result when it triggers" }), h("dd", { class: p.typicalRs > 0 ? "up" : p.typicalRs < 0 ? "down" : "", text: p.typicalRs == null ? "-" : fmt.signedRs(p.typicalRs) }),
      h("div", { class: "sep" }),
      h("dt", { text: "Chance it triggers at all" }), h("dd", { text: p.pTrigger == null ? "-" : fmt.prob(p.pTrigger) }),
      h("dt", { text: meets ? `Chance of ${fmt.rs(res.inputs.target)} or more` : "Chance of the best case" }),
      h("dd", { text: meets ? chance(p.pTarget, p.pTargetBound) : chance(p.pBest) }),
      h("dt", { text: "This rule's record here" }), h("dd", { class: p.expectancyR > 0 ? "up" : p.expectancyR < 0 ? "down" : "", text: record })),
    p.limitedBy === "risk" ? h("p", { class: "muted small", text: "Quantity is set by your risk limit, so part of the amount stays unused." }) : null,
    h("button", { class: "btn", type: "button", text: `Open ${p.symbol} on the Today page`, onclick: () => hooks.go("today", { s: p.symbol, k: p.kind }) }));
}
