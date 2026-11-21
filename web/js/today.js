// Today page: market watch, the selected stock's plan, forecast, statistics and last result.
import { candleChart, histogram, ring } from "./charts.js";
import { arrow, charges, clear, countUp, dir, fmt, fmtDate, getJSON, h, hideTip, icon, ok, position, prefs,
         reveal, symbolFile, tipHead, tipNote, tipRow, withTip } from "./core.js";
import { marketStats, plainWords, ruleTable } from "./insight.js";

const RULES = {
  breakout: { short: "Breakout", name: "Breakout above yesterday's high" },
  pullback: { short: "Dip buy", name: "Dip toward support" },
  gap_reversal: { short: "Gap reversal", name: "Gap-down reversal at the open" },
};
const CALLS = {
  NO_TRADE: { text: "WAIT", icon: "pause" },                        // same words as Home
  NEUTRAL: { text: "WEAK SIGNAL", icon: "minus" },
  FAVOURABLE: { text: "STRONGER SIGNAL (UNPROVEN)", icon: "check" },
};
const OUTCOME = {
  not_triggered: ["NOT TRIGGERED", "idle"], cancelled: ["CANCELLED", "idle"], none: ["NO PLAN", "idle"],
  stopped: ["STOPPED", "bad"], t1: ["TARGET 1 HIT", "good"], t2: ["TARGET HIT", "good"], time: ["TIME EXIT", null],
};

export async function renderToday(root, ctx) {
  const { meta, market, params, go } = ctx;
  const symbols = market.heatmap.map((x) => x.symbol);
  let sym = params.get("s");
  if (!symbols.includes(sym)) sym = symbols.includes(prefs.get("sym")) ? prefs.get("sym") : symbols[0];
  prefs.set("sym", sym);

  const [data, day] = await Promise.all([
    getJSON(symbolFile(sym)),
    getJSON(`days/${meta.last_eod_date}/summary.json`, { optional: true }),
  ]);

  const plans = data.plans || {};
  const asked = params.get("k");
  const state = {
    kind: plans[asked] ? asked : plans[data.call.kind] ? data.call.kind : plans[data.call.reference_kind] ? data.call.reference_kind : Object.keys(plans)[0],
    capital: prefs.get("capital", meta.costs.reference.capital),
    riskPct: prefs.get("risk", meta.costs.reference.risk_pct),
    filter: prefs.get("filter", "all"), query: "",
  };

  clear(root);
  const desk = h("div", { class: "desk" });
  const colWatch = h("div", { class: "col" }), colMain = h("div", { class: "col" }), colTicket = h("div", { class: "col col-ticket" });
  desk.append(colWatch, colMain, colTicket);
  root.append(desk);

  colWatch.append(watchCard(market, sym, state, (pick) => go("today", { s: pick })));
  let chart = null;
  // Switching rule tabs redraws both columns. `root` is only a staging element that the
  // router empties once the page is shown, so the fade-in has to be applied to `desk`,
  // which stays on the page; revealing `root` left every redrawn card invisible.
  const drawStock = () => {
    clear(colMain); clear(colTicket);
    chart = null;
    const hooks = { setKind: (k) => { state.kind = k; drawStock(); }, highlight: (key) => chart && chart.highlight(key) };
    try {
      if (!plans[state.kind] || !plans[state.kind].levels) throw new Error("No levels were published for this rule.");
      const parts = stockView(data, day, meta, state, hooks);
      chart = parts.chart;
      colMain.append(...parts.main);
      colTicket.append(...parts.side);
    } catch (err) {
      colMain.append(problemCard(data, state, hooks, err));
    }
    reveal(desk);
  };
  drawStock();

  root.append(h("div", { class: "stack", style: { marginTop: "16px" } }, marketCard(market, (pick) => go("today", { s: pick })), heatCard(market, (pick) => go("today", { s: pick })), contextCard(market)));
  reveal(root);
}

// ------------------------------------------------------- in plain words
function factValue(v) {
  if (!v) return "-";
  switch (v.kind) {
    case "px": return "₹" + fmt.px(v.x);
    case "pct": return fmt.pct(v.x) + (v.suffix || "");
    case "plusminus": return "±" + fmt.num(v.x, 1) + "%";
    case "prob": return fmt.prob(v.x);
    case "range": return `₹${fmt.px(v.lo)} to ₹${fmt.px(v.hi)}`;
    case "pct0": return fmt.pct0(v.x, 1);
    case "times": return fmt.num(v.x, 2) + "×";
    case "score": return `${Math.round(v.x)} / 100`;
    case "int": return fmt.int(v.x);
    default: return v.text || "-";
  }
}
function plainCard(d) {
  const p = plainWords(d);
  const light = h("div", { class: "light " + p.tone, role: "img", "aria-label": `Verdict: ${p.headline}` }, h("i"), h("i"), h("i"));
  return h("section", { class: "card reveal plain " + p.tone },
    h("div", { class: "card-h" }, h("h3", { text: "In plain words" }), h("span", { class: "hint", text: "No jargon; the detail is further down" })),
    h("div", { class: "card-b" },
      h("div", { class: "plain-top" }, light, h("div", {}, h("b", { class: "plain-h", text: p.headline }), h("p", { text: p.text }))),
      h("div", { class: "facts" }, p.facts.map((f, i) => h("div", { class: "fact", style: { animationDelay: 80 + i * 55 + "ms" } },
        h("div", { class: "fl", text: f.label }),
        h("div", { class: "fv " + (f.key === "close" ? dir(f.dir) : ""), text: factValue(f.value) }),
        f.note ? h("div", { class: "fn", text: factValue(f.note) }) : null,
        f.key === "up" ? h("div", { class: "meter go split" }, h("i", { vars: { "--v": f.value.x } })) : null,
        f.key === "health" ? h("div", { class: "meter go" }, h("i", { vars: { "--v": f.value.x / 100 } })) : null))),
      h("a", { class: "linkish", href: `#/accuracy?s=${encodeURIComponent(d.symbol)}`, text: `How accurate have past predictions for ${d.symbol} been? See them against the real prices →` })));
}

// ------------------------------------------- the three rules side by side
function rulesCard(d, state, hooks) {
  const rows = ruleTable(d);
  if (!rows.length) return null;
  const bar = (v, cls) => h("div", { class: "mbar " + (cls || "") }, h("i", { vars: { "--v": ok(v) ? Math.max(0, Math.min(1, v)) : 0 } }));
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "The three rules, side by side" }), h("span", { class: "hint", text: `Their past record on ${d.symbol}, after costs` })),
    h("div", { class: "card-b scroll-x" },
      h("table", { class: "tbl rules-tbl" },
        h("thead", {}, h("tr", {}, h("th", { text: "Rule" }), h("th", { class: "n", text: "Past trades" }), h("th", { text: "Won" }), h("th", { text: "Hit a target" }),
          h("th", { text: "Stopped out" }), h("th", { class: "n", text: "Average result" }), h("th", { class: "n", text: "Longest losing run" }), h("th", { text: "Chance it triggers today" }))),
        h("tbody", {}, rows.map((r) => h("tr", { class: "rrow" + (r.kind === state.kind ? " on" : ""), tabindex: 0, role: "button", "aria-label": `Show ${(RULES[r.kind] || { short: r.kind }).short} levels`,
          onclick: () => hooks.setKind(r.kind), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hooks.setKind(r.kind); } } },
          h("td", {}, h("b", { text: (RULES[r.kind] || { short: r.kind }).short }), r.called ? h("span", { class: "pill amber", style: { marginLeft: "6px" }, text: "called" }) : null),
          h("td", { class: "n", text: fmt.int(r.trades) }),
          h("td", {}, fmt.prob(r.winRate), bar(r.winRate, "s1")),
          h("td", {}, fmt.prob(r.targetShare), bar(r.targetShare, "up")),
          h("td", {}, fmt.prob(r.stoppedShare), bar(r.stoppedShare, "down")),
          h("td", { class: "n " + dir(r.expectancyR), text: fmt.r(r.expectancyR) }),
          h("td", { class: "n", text: ok(r.losingStreak) ? `${fmt.int(r.losingStreak)} in a row` : "-" }),
          h("td", {}, fmt.prob(r.pTrigger), bar(r.pTrigger, "accent")))))),
      h("p", { class: "muted small", style: { marginTop: "10px" }, text: "Tap a row to see that rule's levels. “Average result” is in R, the amount risked per trade: below zero means the rule lost money on average." })));
}

// ---------------------------------------------------- market at a glance
function marketCard(market, pick) {
  const m = marketStats(market.heatmap);
  if (!m.count) return null;
  const num = (label, to, format, note, cls) => {
    const v = h("div", { class: "sv " + (cls || "") });
    countUp(v, to, format, 800);
    return h("div", { class: "stat" }, h("div", { class: "sl", text: label }), v, h("div", { class: "sn", text: note }));
  };
  const total = Math.max(1, m.advancers + m.decliners + m.unchanged);
  const split = h("div", { class: "split", role: "img", "aria-label": `${m.advancers} rose, ${m.unchanged} unchanged, ${m.decliners} fell` },
    h("i", { class: "u", style: { flexGrow: m.advancers } }), h("i", { class: "f", style: { flexGrow: m.unchanged } }), h("i", { class: "d", style: { flexGrow: m.decliners } }));
  const movers = (title, list, cls) => h("div", { class: "movers" }, h("div", { class: "eyebrow", text: title }),
    list.length ? list.map((r, i) => h("button", { class: "mover", type: "button", style: { animationDelay: i * 60 + "ms" }, onclick: () => pick(r.symbol), "aria-label": `${r.symbol} ${fmt.pct(r.change_pct)}` },
      h("span", { class: "mv-s", text: r.symbol }),
      h("span", { class: "mv-bar " + cls }, h("i", { vars: { "--v": Math.min(1, Math.abs(r.change_pct) / (m.biggestMove || 1)) } })),
      h("span", { class: "mv-c " + cls, text: fmt.pct(r.change_pct) })))
      : h("p", { class: "muted small", text: "None today." }));
  const callsTotal = Math.max(1, m.count);
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "The market at a glance" }), h("span", { class: "hint", text: `All ${m.count} stocks at the last close: ${m.mood}` })),
    h("div", { class: "card-b", style: { display: "grid", gap: "14px" } },
      h("div", {}, split, h("div", { class: "split-l" }, h("span", { class: "up", text: `▲ ${m.advancers} rose (${fmt.pct0((m.advancers / total) * 100)})` }),
        m.unchanged ? h("span", { class: "muted", text: `${m.unchanged} unchanged` }) : null, h("span", { class: "down", text: `▼ ${m.decliners} fell (${fmt.pct0((m.decliners / total) * 100)})` }))),
      h("div", { class: "ctx" },
        num("AVERAGE MOVE", m.avgChange, (v) => fmt.pct(v), `the middle stock moved ${fmt.pct(m.medianChange)}`, dir(m.avgChange)),
        num("BIGGEST MOVE", m.biggestMove, (v) => fmt.pct0(v, 2), "largest rise or fall of any stock"),
        num("TYPICAL DAILY SWING", m.avgAtr, (v) => "±" + fmt.num(v, 2) + "%", "average across all 50 (ATR)"),
        num("LEAN UP NEXT SESSION", m.leanUp, (v) => fmt.int(Math.round(v)), `of ${m.count}; ${m.leanDown} lean down`),
        num("AVERAGE UP CHANCE", ok(m.avgPUp) ? m.avgPUp * 100 : null, (v) => fmt.pct0(v, 1), "50% would be a coin flip"),
        num("AVERAGE TREND HEALTH", m.avgHealth, (v) => fmt.int(Math.round(v)), "out of 100; descriptive only"),
        num("STOCKS WITH A PLAN", m.withPlan, (v) => fmt.int(Math.round(v)), `${m.calls.NO_TRADE} of ${callsTotal} are “no trade”`),
        num("FAVOURABLE CALLS", m.calls.FAVOURABLE, (v) => fmt.int(Math.round(v)), `${m.calls.NEUTRAL} neutral`)),
      h("div", { class: "grid2" }, movers("Biggest rises", m.gainers, "up"), movers("Biggest falls", m.losers, "down"))));
}

// Shown instead of a blank column when a rule's data is missing or malformed.
function problemCard(d, state, hooks, err) {
  const others = Object.keys(d.plans || {}).filter((k) => k !== state.kind && d.plans[k] && d.plans[k].levels);
  const name = (RULES[state.kind] || { short: state.kind || "this rule" }).short;
  return h("section", { class: "card reveal", role: "alert" },
    h("div", { class: "card-h" }, h("h3", { text: `${name} levels for ${d.symbol} cannot be shown` })),
    h("div", { class: "card-b", style: { display: "grid", gap: "10px", justifyItems: "start" } },
      h("p", { text: "The data for this rule is missing or incomplete in the latest update. Nothing is wrong with your device; the other rules and stocks are unaffected." }),
      h("p", { class: "muted small", text: String((err && err.message) || err) }),
      others.length ? h("div", { class: "chips" }, others.map((k) => h("button", { class: "chip", type: "button", text: `Show ${(RULES[k] || { short: k }).short.toLowerCase()}`, onclick: () => hooks.setKind(k) }))) : null));
}

// ------------------------------------------------------------- market watch
function watchCard(market, current, state, pick) {
  const list = h("div", { class: "watch-list", role: "list" });
  const filters = { all: "All", plan: "Has a plan", up: "Gainers", down: "Losers" };
  const draw = () => {
    clear(list);
    const q = state.query.trim().toUpperCase();
    let rows = market.heatmap.filter((r) => !q || r.symbol.includes(q));
    if (state.filter === "plan") rows = rows.filter((r) => r.call !== "NO_TRADE");
    if (state.filter === "up") rows = rows.filter((r) => r.change_pct > 0).sort((a, b) => b.change_pct - a.change_pct);
    if (state.filter === "down") rows = rows.filter((r) => r.change_pct < 0).sort((a, b) => a.change_pct - b.change_pct);
    if (!rows.length) list.append(h("p", { class: "muted small", style: { padding: "14px 12px" }, text: "No stocks match." }));
    for (const r of rows) {
      const row = h("button", { class: "wrow" + (r.symbol === current ? " on" : ""), type: "button", role: "listitem", onclick: () => pick(r.symbol) },
        h("div", { class: "wsym" }, h("i", { class: "wdot " + r.call, title: r.call === "NO_TRADE" ? "No plan" : "Has a plan" }), h("span", { text: r.symbol })),
        h("div", { class: "wpx", text: fmt.px(r.close) }),
        h("div", { class: "wch " + dir(r.change_pct), text: fmt.pct(r.change_pct) }));
      list.append(row);
    }
  };
  const chips = h("div", { class: "chips" }, Object.entries(filters).map(([k, label]) =>
    h("button", { class: "chip" + (state.filter === k ? " on" : ""), type: "button", text: label, onclick: (e) => {
      state.filter = k; prefs.set("filter", k);
      e.currentTarget.parentNode.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === e.currentTarget));
      draw();
    } })));
  const search = h("div", { class: "search" }, icon("search"),
    h("input", { type: "search", placeholder: "Search Nifty 50", "aria-label": "Search stocks", oninput: (e) => { state.query = e.target.value; draw(); } }));
  draw();
  return h("section", { class: "card watch sticky reveal", "aria-label": "Market watch" },
    h("div", { class: "watch-top" }, h("div", { class: "eyebrow", text: "Market watch · NSE" }), search, chips),
    h("div", { class: "watch-head" }, h("span", { text: "SYMBOL" }), h("span", { text: "CLOSE" }), h("span", { text: "CHG" })),
    list);
}

// -------------------------------------------------------------- stock view
function levelSet(plan, kind) {
  const L = plan.levels;
  if (kind === "gap_reversal") {
    return [
      { key: "t1", cls: "target", tag: "TARGET", short: "TARGET", value: L.t1, p: L.p_t1, note: "yesterday's close: the gap is filled" },
      { key: "entry", cls: "entry", tag: "OPEN AT/BELOW", short: "OPEN ≤", value: L.entry, p: L.p_trigger, note: "enter at the open only if it opens here or lower" },
      { key: "stop", cls: "stop", tag: "STOP", value: L.stop, note: `${fmt.px(L.stop_distance)} below your actual fill`, approx: true },
      { key: "floor", cls: "ref", tag: "NO ENTRY BELOW", short: "FLOOR", value: L.floor, note: "a gap this large is treated as news" },
    ];
  }
  return [
    { key: "t2", cls: "target", tag: "TARGET 2", short: "T2", value: L.t2, p: L.p_t2, note: "exit the rest" },
    { key: "t1", cls: "target", tag: "TARGET 1", short: "T1", value: L.t1, p: L.p_t1, note: "exit half" },
    { key: "entry", cls: "entry", tag: "ENTRY", value: L.entry, p: L.p_trigger, note: kind === "breakout" ? "enter if price trades through" : "enter if price dips through" },
    { key: "stop", cls: "stop", tag: "STOP", value: L.stop, note: "exit everything" },
  ];
}

function ifThen(plan, kind) {
  const L = plan.levels, b = (x) => h("b", { text: "₹" + fmt.px(x) });
  if (kind === "gap_reversal")
    return ["If the stock opens at or below ", b(L.entry), " (and not below ", b(L.floor), "), this plan would enter at the open. Stop: ",
            h("b", { text: "₹" + fmt.px(L.stop_distance) }), " below the fill. Target: yesterday's close ", b(L.t1),
            `. Anything still open is closed at ${plan.exit_by} IST.`];
  const verb = kind === "breakout" ? "trades through" : "dips through";
  return ["If the price ", verb, " ", b(L.entry), ` before ${plan.cancel_after} IST, this plan would enter. Stop `, b(L.stop),
          ", first target ", b(L.t1), ", second target ", b(L.t2), `. Anything still open is closed at ${plan.exit_by} IST.`];
}

function stockView(d, day, meta, state, hooks) {
  const plan = d.plans[state.kind];
  const levels = levelSet(plan, state.kind);
  const called = d.call.call !== "NO_TRADE" && d.call.kind === state.kind;
  const last = d.last.close;

  // --- hero
  const lastEl = h("div", { class: "hero-last num" });
  countUp(lastEl, last, (v) => "₹" + fmt.px(v));
  const cm = CALLS[d.call.call];
  const hero = h("section", { class: "card reveal" },
    h("div", { class: "hero" },
      h("div", {},
        h("div", { class: "eyebrow", text: `NSE: ${d.symbol}` }),
        h("h1", { class: "hero-name", text: d.name || d.symbol }),
        h("div", { class: "hero-meta" },
          d.industry ? h("span", { class: "tag", text: d.industry }) : null,
          h("span", { class: "tag", text: `Liquidity tier ${d.liquidity_tier}` }),
          h("span", { text: `Official close of ${fmtDate(d.as_of, true)}` }))),
      h("div", { class: "hero-px" }, lastEl,
        h("div", { class: "hero-chg " + dir(d.last.change_pct), text: `${arrow(d.last.change_pct)} ${fmt.pct(d.last.change_pct)}` }),
        h("div", { class: "muted small num", text: `O ${fmt.px(d.last.open)} · H ${fmt.px(d.last.high)} · L ${fmt.px(d.last.low)}` }))),
    h("div", { class: "callbar" },
      h("span", { class: "call " + d.call.call }, icon(cm.icon), `${cm.text} · ${d.call.label}`),
      h("div", { class: "call-why", text: d.call.reasons.join(" ") })));

  // --- chart
  const chartEl = h("div", { class: "chart" });
  const chart = candleChart(chartEl, d.series, {
    levels: levels.map((x) => ({ key: x.key, cls: x.cls, value: x.value, label: `${x.short || x.tag} ${fmt.px(x.value)}` })),
    cone: d.claims ? d.claims.close : null,
  });
  const chartCard = h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: `Daily candles with the ${RULES[state.kind].short.toLowerCase()} levels` }),
      h("span", { class: "hint", text: d.series.unit === "inr" ? "Rupees" : "% relative to the latest close" })),
    h("div", { class: "chart-wrap" }, chartEl),
    h("div", { class: "legend" },
      h("span", {}, h("i", { class: "k1" }), "20-day average"), h("span", {}, h("i", { class: "k2" }), "50-day average"),
      d.claims ? h("span", {}, h("i", { class: "sw", style: { background: "var(--s1)", opacity: ".45" } }), "Next session: 90% range (pale), middle half (dark), median") : null));

  const main = [hero, plainCard(d), chartCard];
  const res = resultCard(d, day);
  if (res) main.push(res);
  main.push(stepsCard(d, plan, state, called), rulesCard(d, state, hooks), forecastCard(d), statsCard(d));

  // --- ticket
  const tabs = h("div", { class: "ticket-tabs", role: "tablist" }, Object.keys(d.plans).map((k) =>
    h("button", { class: "tab" + (k === state.kind ? " on" : ""), type: "button", role: "tab", "aria-selected": k === state.kind, onclick: () => hooks.setKind(k) },
      (RULES[k] || { short: k }).short, h("small", { text: d.call.kind === k ? "called" : d.call.reference_kind === k ? "reference" : "what-if" }))));
  const ladder = h("div", { class: "ladder" }, levels.map((x) => {
    const rung = h("div", { class: "rung " + x.cls, tabindex: 0,
      onpointerenter: () => hooks.highlight(x.key), onpointerleave: () => hooks.highlight(null),
      onfocus: () => hooks.highlight(x.key), onblur: () => hooks.highlight(null) },
      h("div", { class: "rk", text: x.tag }),
      h("div", { class: "rv" }, (x.approx ? "~" : "") + fmt.px(x.value), h("small", { text: fmt.pct((x.value / last - 1) * 100) })),
      h("div", { class: "rp" }, x.p != null ? [h("b", { text: fmt.prob(x.p) }), "chance"] : null));
    return withTip(rung, () => [tipHead(x.tag), tipNote(x.note),
      x.p != null ? tipNote(`On ${fmt.prob(x.p)} of similar past days the session reached this price.`) : null]);
  }));

  const money = h("div", { style: { display: "grid", gap: "12px" } });
  const drawMoney = () => { clear(money).append(...moneyBlocks(d, plan, state, meta)); };
  const field = (label, key, prefix, suffix, step, min) => h("div", { class: "field" },
    h("label", { for: "f-" + key, text: label }),
    h("div", { class: "inp" }, prefix ? h("span", { text: prefix }) : null,
      h("input", { id: "f-" + key, type: "number", inputmode: "decimal", min, step, value: state[key],
        oninput: (e) => { const v = parseFloat(e.target.value); if (v > 0) { state[key] = v; prefs.set(key === "riskPct" ? "risk" : "capital", v); drawMoney(); document.dispatchEvent(new CustomEvent("dd-money")); } } }),
      suffix ? h("span", { text: suffix }) : null));
  drawMoney();

  const ticket = h("section", { class: "card ticket reveal", "aria-label": "Plan ticket" },
    tabs,
    h("div", { class: "ticket-b" },
      h("div", {}, h("div", { class: "eyebrow", text: called ? "If-then plan" : "Reference levels (not a plan)" }),
        h("div", { class: "ifthen", style: { marginTop: "6px" } }, ifThen(plan, state.kind))),
      ladder,
      h("div", { class: "fields" }, field("CAPITAL", "capital", "₹", null, 1000, 1000), field("RISK PER TRADE", "riskPct", null, "%", 0.1, 0.1)),
      money));

  return { chart, main: main.filter(Boolean), side: [ticket, evidenceCard(d, state.kind), healthCard(d)] };
}

function moneyBlocks(d, plan, state, meta) {
  const L = plan.levels;
  const pos = position(L.entry, L.stop, state.capital, state.riskPct);
  const buy = pos.shares * L.entry;
  const cT = charges(buy, pos.shares * L.t1, meta.costs), cS = charges(buy, pos.shares * L.stop, meta.costs);
  const kv = h("dl", { class: "kv" },
    h("dt", { text: "Quantity" }), h("dd", { text: pos.shares ? `${fmt.int(pos.shares)} shares` : "0 (stop too wide for this capital)" }),
    h("dt", { text: "Position value" }), h("dd", { text: fmt.rs(pos.value) }),
    h("dt", { text: "Loss if stopped" }), h("dd", { class: "down", text: pos.shares ? fmt.signedRs(-(pos.riskRs + cS.total)) : "-" }),
    h("dt", { text: "Gain at first target" }), h("dd", { class: "up", text: pos.shares ? fmt.signedRs(pos.shares * (L.t1 - L.entry) - cT.total) : "-" }),
    h("dt", { text: "Charges (round trip)" }), h("dd", { text: pos.shares ? fmt.rs2(cT.total) : "-" }));
  const more = h("details", { class: "more" }, h("summary", { text: "Charges breakdown" }),
    h("dl", { class: "kv" }, [["Brokerage", "brokerage"], ["STT", "stt"], ["Exchange", "exchange"], ["SEBI fee", "sebi"], ["Stamp duty", "stamp"], ["GST", "gst"]]
      .flatMap(([label, k]) => [h("dt", { text: label }), h("dd", { text: fmt.rs2(cT[k]) })])));
  const out = [kv];
  if (pos.capped) out.push(h("p", { class: "muted small", text: "Quantity is limited by capital, so the loss at the stop is smaller than your risk setting." }));
  out.push(more);

  const rule = d.rules[state.kind];
  const q = rule && rule.r_quantiles;
  if (q && pos.shares) {
    const lo = Math.min(q.p05, -1.2), hi = Math.max(q.p95, 1.2), X = (v) => ((v - lo) / (hi - lo)) * 100;
    const rsOf = (rr) => fmt.signedRs(rr * pos.riskRs);
    out.push(h("div", { class: "scen" },
      h("div", { class: "eyebrow", text: "If it triggers: what this rule did before, after costs" }),
      h("div", { class: "scen-bar" },
        h("div", { class: "scen-zero", style: { left: X(0) + "%" } }),
        h("div", { class: "scen-span", style: { left: X(q.p05) + "%", width: X(q.p95) - X(q.p05) + "%" } }),
        h("div", { class: "scen-mid", style: { left: X(q.p50) + "%" } })),
      h("div", { class: "scen-vals" },
        h("div", {}, h("b", { class: "down", text: rsOf(q.p05) }), h("span", { text: "worst 1 in 20" })),
        h("div", {}, h("b", { text: rsOf(q.p50) }), h("span", { text: "typical" })),
        h("div", {}, h("b", { class: "up", text: rsOf(q.p95) }), h("span", { text: "best 1 in 20" })))));
  }
  return out;
}

let moneyListener = null;
function stepsCard(d, plan, state, called) {
  const L = plan.levels, k = state.kind;
  const box = h("div", { class: "steps" });
  const draw = () => {
    clear(box);
    const pos = position(L.entry, L.stop, state.capital, state.riskPct);
    const px = (x) => "₹" + fmt.px(x);
    const step = (when, title, text) => h("div", { class: "step" }, h("div", {}, h("div", { class: "when", text: when }), h("b", { text: title }), h("p", { text })));
    const steps = [];
    if (!called) steps.push(step("FIRST", "There is no plan for this stock today",
      `${d.call.reasons.join(" ")} The steps below describe the ${RULES[k].short.toLowerCase()} rule as a what-if only.`));
    if (k === "gap_reversal") {
      steps.push(step("BEFORE 09:15 IST", "Note one number", `The trigger is an opening price of ${px(L.entry)} or lower. On similar days that happened ${fmt.prob(L.p_trigger)} of the time, so most days this plan does nothing.`));
      steps.push(step("09:15 IST", "Look at the opening price", `If it opens between ${px(L.floor)} and ${px(L.entry)}, the plan would enter at the open. Otherwise it is cancelled for the day.`));
      steps.push(step("ON ENTRY", "Set the stop from your fill", `Stop is ${px(L.stop_distance)} below the price you actually got. With ${fmt.rs(state.capital)} and ${state.riskPct}% risk that is ${fmt.int(pos.shares)} shares.`));
      steps.push(step("DURING THE DAY", "One target", `Exit everything if the price returns to yesterday's close, ${px(L.t1)}.`));
    } else {
      steps.push(step("BEFORE 09:15 IST", "Note the levels, place nothing", `Entry ${px(L.entry)}, stop ${px(L.stop)}. If the stock opens at or below the stop${k === "breakout" ? ` or above ${px(L.t1)}` : ""}, the plan is cancelled.`));
      steps.push(step(`09:15 TO ${plan.cancel_after} IST`, k === "breakout" ? "Enter only on a break" : "Enter only on a dip",
        `If the price ${k === "breakout" ? "trades through" : "dips through"} ${px(L.entry)}, the plan would enter. On similar days that happened ${fmt.prob(L.p_trigger)} of the time.`));
      steps.push(step("ON ENTRY", "Size the position from the stop", `Risk is ${px(L.risk)} per share. With ${fmt.rs(state.capital)} and ${state.riskPct}% risk that is ${fmt.int(pos.shares)} shares (${fmt.rs(pos.value)}).`));
      steps.push(step("DURING THE DAY", "Two targets, one stop", `Exit half at ${px(L.t1)} and the rest at ${px(L.t2)}. Exit everything at ${px(L.stop)}.`));
      steps.push(step(`${plan.cancel_after} IST`, "Cancel if nothing happened", "An entry that has not triggered by now is dropped."));
    }
    steps.push(step(`${plan.exit_by} IST`, "Close whatever is open", "Nothing is carried overnight. The result is published after the official close data arrives, usually after 18:00 IST."));
    box.append(...steps);
  };
  draw();
  if (moneyListener) document.removeEventListener("dd-money", moneyListener);   // one listener, however often the card is redrawn
  moneyListener = draw;
  document.addEventListener("dd-money", draw);
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Your move, step by step" }), h("span", { class: "hint", text: `For ${fmtDate(d.for_date, true)}` })),
    h("div", { class: "card-b" }, box));
}

// ------------------------------------------------------------- forecast
function forecastCard(d) {
  if (!d.claims || !d.forecast) {
    return h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "Next-session forecast" })),
      h("div", { class: "card-b muted", text: "Not enough comparable history for a forecast." }));
  }
  const c = d.claims, f = d.forecast, parts = c.dir.parts || {};
  const histEl = h("div", { class: "chart" });
  histogram(histEl, d.distribution.close, [
    { value: c.close.p05, label: "5%" }, { value: c.close.p50, label: "median" }, { value: c.close.p95, label: "95%" }]);
  const touchName = { up_half_atr: "Half an ATR above the close", down_half_atr: "Half an ATR below the close", prev_high: "Yesterday's high", prev_low: "Yesterday's low" };
  const kv = h("dl", { class: "kv" },
    h("dt", { text: "Chance of an up close" }), h("dd", { text: fmt.prob(c.dir.p_up, 1) }),
    h("dt", { class: "muted small", text: "  plain history · logistic model · tree model" }),
    h("dd", { class: "muted small", text: [parts.simple, parts.logistic, parts.trees].map((p) => fmt.prob(p, 0)).join(" · ") }),
    h("div", { class: "sep" }),
    h("dt", { text: "Close, 90% range" }), h("dd", { text: `${fmt.pct(c.close.p05, 1)} to ${fmt.pct(c.close.p95, 1)}` }),
    h("dt", { text: "  in rupees" }), h("dd", { text: `${fmt.px(d.last.close * (1 + c.close.p05 / 100))} to ${fmt.px(d.last.close * (1 + c.close.p95 / 100))}` }),
    h("dt", { text: "Opening gap, 90% range" }), h("dd", { text: `${fmt.pct(c.gap.p05, 1)} to ${fmt.pct(c.gap.p95, 1)}` }),
    h("dt", { text: "Session high-low range" }), h("dd", { text: `typically ${fmt.pct0(c.range.p50, 1)}, rarely over ${fmt.pct0(c.range.p90, 1)}` }),
    h("div", { class: "sep" }),
    c.touch.flatMap((t) => [h("dt", { text: `${touchName[t.name]} (${fmt.px(t.level)})` }), h("dd", { text: fmt.prob(t.p) })]),
    h("div", { class: "sep" }),
    h("dt", { text: "Similar past days used" }), h("dd", { text: `${fmt.int(f.n)} (${f.tier_name})` }),
    h("dt", { text: "Overnight US move" }), h("dd", { text: `${fmt.signed(d.overnight_z, 2)} sd` }));
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "What similar days did next" }),
      h("span", { class: "hint", text: "Close-to-close change of the following session" })),
    h("div", { class: "card-b" },
      h("div", { class: "grid2" }, h("div", {}, histEl,
        h("p", { class: "muted small", text: "Scenarios, not a prediction: each bar counts past days that looked like today, scaled to today's volatility and shifted by the overnight US move." })), kv)));
}

// ----------------------------------------------------------------- stats
function statsCard(d) {
  const body = h("div", { class: "cells" });
  let current = d.stats[0].group;
  const draw = () => {
    clear(body);
    const group = d.stats.find((g) => g.group === current);
    for (const c of group.cells) {
      const unit = c.unit === "pct" ? "" : c.unit;
      const text = !ok(c.value) ? "-" : c.unit === "%" || c.unit === "pts" ? fmt.signed(c.value, c.value % 1 ? 1 : 0)
        : c.unit === "cr" ? fmt.int(c.value) : String(c.value);
      const cell = h("div", { class: "cell", tabindex: 0 },
        h("div", { class: "cl", text: c.label }),
        h("div", { class: "cv" }, text, unit && ok(c.value) ? h("small", { text: unit === "cr" ? "₹ cr" : unit }) : null),
        c.unit === "pct" && ok(c.value) ? h("div", { class: "meter go" }, h("i", { vars: { "--v": c.value / 100 } })) : null);
      body.append(withTip(cell, () => [tipHead(c.label), tipNote(c.note)]));
    }
  };
  const tabs = h("div", { class: "tabs" }, d.stats.map((g) => h("button", { class: "chip" + (g.group === current ? " on" : ""), type: "button", text: g.group, onclick: (e) => {
    current = g.group;
    e.currentTarget.parentNode.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === e.currentTarget));
    draw();
  } })));
  draw();
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Statistics" }), h("span", { class: "hint", text: "Hover a tile for what it means" })),
    h("div", { style: { paddingTop: "10px" } }, tabs), h("div", { class: "card-b" }, body));
}

// -------------------------------------------------------------- evidence
function evidenceCard(d, kind) {
  const r = d.rules[kind] || {}, ev = (d.evidence || {})[kind] || {};
  const stat = (label, value, note, cls) => h("div", { class: "stat" }, h("div", { class: "sl", text: label }),
    h("div", { class: "sv " + (cls || ""), text: value }), h("div", { class: "sn", text: note }));
  const exp = r.expectancy_r;
  const stats = h("div", { class: "evid" },
    stat("TRADES", fmt.int(r.trades), `of ${fmt.int(r.plans)} plans`),
    stat("WIN RATE", ok(r.win_rate) ? fmt.prob(r.win_rate) : "-", "after costs"),
    stat("AVG RESULT", fmt.r(exp), "per trade", dir(exp)),
    stat("T-STAT", ok(r.t_stat) ? fmt.signed(r.t_stat, 1) : "-", "2+ is solid"),
    stat("WORST RUN", ok(r.max_drawdown_r) ? fmt.num(r.max_drawdown_r, 0) + " R" : "-", "max drawdown"),
    stat("TRIGGERS", ok(r.trigger_rate) ? fmt.prob(r.trigger_rate) : "-", "of all days"));
  const mc = r.monte_carlo;
  const verdict = !ev.enough
    ? `Only ${fmt.int(ev.n)} past trades on this stock: too few to judge this rule here.`
    : ev.shrunk_r > 0
      ? `After costs this rule averaged ${fmt.r(ev.expectancy_r)} per trade on this stock (${fmt.int(ev.n)} trades). Across all 50 stocks it averages ${fmt.r(r.pooled_expectancy_r)}. Blending the two gives ${fmt.r(ev.shrunk_r)}: positive, but ${ev.t_stat >= 2 ? "reasonably well supported" : "weak evidence that could be luck"}.`
      : `After costs this rule averaged ${fmt.r(ev.expectancy_r)} per trade on this stock (${fmt.int(ev.n)} trades). Across all 50 stocks it averages ${fmt.r(r.pooled_expectancy_r)}. No tested edge.`;
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: `This rule's record on ${d.symbol}` }), h("span", { class: "hint", text: "R = amount risked" })),
    h("div", { class: "card-b", style: { display: "grid", gap: "10px" } }, stats,
      h("div", { class: "verdict" }, icon("info"), h("div", { text: verdict })),
      mc ? h("p", { class: "muted small", text: `Over a run of ${mc.trades} trades (1,000 resamples of the past): total between ${fmt.r(mc.total_r.p05, 1)} and ${fmt.r(mc.total_r.p95, 1)}, typically ${fmt.r(mc.total_r.p50, 1)}; chance of ending ahead ${fmt.prob(mc.p_profit)}.` }) : null,
      h("p", { class: "muted small", text: "History uses daily bars with the stop assumed first whenever a bar is ambiguous. Results dates and news are not modelled." })));
}

function healthCard(d) {
  const names = { trend: "Trend", level: "Not stretched", momentum: "Momentum", participation: "Participation", risk: "Calm regime" };
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Trend health" }), h("span", { class: "hint", text: "0 to 100" })),
    h("div", { class: "card-b", style: { display: "grid", gap: "10px" } },
      h("div", { class: "ring" }, ring(d.health.score, "Trend health"),
        h("div", { class: "parts" }, Object.entries(d.health.parts).map(([k, v]) => h("div", { class: "part" },
          h("span", { text: names[k] || k }), h("div", { class: "meter go" }, h("i", { vars: { "--v": v } })), h("b", { text: Math.round(v * 100) }))))),
      h("p", { class: "muted small", text: d.health.note })));
}

// ------------------------------------------------------------ last result
function resultCard(d, day) {
  const row = day && day.rows.find((r) => r.symbol === d.symbol && r.status === "scored");
  if (!row || !row.range) return null;
  const [p05, p50, p95] = row.range, act = row.actual.ret_pct;
  const lo = Math.min(p05, act) - 0.5, hi = Math.max(p95, act) + 0.5, X = (v) => ((v - lo) / (hi - lo)) * 100;
  const bar = h("div", { class: "rbar", role: "img", "aria-label": `Predicted 90% range ${fmt.pct(p05, 1)} to ${fmt.pct(p95, 1)}; actual ${fmt.pct(act)}` },
    h("div", { class: "rbar-track" }),
    h("div", { class: "rbar-band", style: { left: X(p05) + "%", width: X(p95) - X(p05) + "%" } }),
    h("div", { class: "rbar-mid", style: { left: X(p50) + "%" } }),
    h("div", { class: "rbar-act " + dir(act), style: { left: X(act) + "%" } }, h("i")),
    h("div", { class: "rbar-lab", style: { left: X(p05) + "%" }, text: fmt.pct(p05, 1) }),
    h("div", { class: "rbar-lab", style: { left: X(p95) + "%" }, text: fmt.pct(p95, 1) }));
  const check = (state, label, value) => h("div", { class: "check " + state }, icon(state === "ok" ? "check" : state === "no" ? "cross" : "minus"), h("span", { text: label }), h("b", { text: value }));
  const leaned = row.p_up >= 0.5 ? "up" : "down";
  const touchName = { up_half_atr: "Touch +0.5 ATR", down_half_atr: "Touch −0.5 ATR", prev_high: "Reach prior high", prev_low: "Reach prior low" };
  const checks = h("div", { class: "checks" },
    check(row.dir_correct ? "ok" : "no", `Leaned ${leaned} (${fmt.prob(row.p_up, 0)} up)`, `closed ${fmt.pct(act)}`),
    check(row.inside ? "ok" : "no", "Close inside the 90% range", row.inside ? "yes" : "no"),
    (row.touch || []).map((t) => check("na", `${touchName[t.name]} (said ${fmt.prob(t.p)})`, t.hit ? "happened" : "did not")));
  let stamp = null;
  if (row.plan) {
    const o = row.plan.outcome, [text, tone] = OUTCOME[o.status] || ["-", "idle"];
    const cls = tone || (o.r > 0 ? "good" : "bad");
    stamp = h("div", { style: { display: "grid", gap: "8px", justifyItems: "start" } },
      h("div", { class: "eyebrow", text: `${RULES[row.plan.kind].short} levels` }),
      h("div", { class: "stamp " + cls, text: text + (ok(o.r) ? `  ${fmt.r(o.r)}` : "") }),
      o.fill ? h("p", { class: "muted small num", text: `Filled ${fmt.px(o.fill)}${o.fill_time ? " at " + o.fill_time : ""}, exit ${fmt.px(o.exit)}${o.exit_time ? " at " + o.exit_time : ""}, after costs.` })
             : h("p", { class: "muted small", text: "No position was taken, so nothing was gained or lost." }));
  }
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: `Last session, ${fmtDate(day.date, true)}: predicted vs actual` }),
      h("span", { class: "pill " + (day.track === "live" ? "good" : "amber"), text: day.track === "live" ? "Live" : "Backtest (not live)" })),
    h("div", { class: "card-b result" },
      h("div", {}, h("div", { class: "eyebrow", text: "Close vs the predicted 90% range" }), bar,
        h("p", { class: "muted small num", text: `Open ${fmt.px(row.actual.open)} · High ${fmt.px(row.actual.high)} · Low ${fmt.px(row.actual.low)} · Close ${fmt.px(row.actual.close)}` }),
        stamp ? h("div", { style: { marginTop: "14px" } }, stamp) : null),
      checks));
}

// ---------------------------------------------------------------- heatmap
function heatCard(market, pick) {
  const grid = h("div", { class: "heat" });
  const rows = market.heatmap.slice().sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
  rows.forEach((r, i) => {
    const a = Math.min(0.5, (Math.abs(r.change_pct || 0) / 3) * 0.5) + 0.04;
    const tile = h("button", { class: "tile", type: "button", style: { animationDelay: Math.min(i * 14, 700) + "ms" },
      vars: { "--tone": r.change_pct >= 0 ? "var(--up)" : "var(--down)", "--a": a.toFixed(3) }, onclick: () => { hideTip(); pick(r.symbol); },
      "aria-label": `${r.symbol} ${fmt.pct(r.change_pct)}` },
      r.call !== "NO_TRADE" ? h("i", { class: "tk" }) : null,
      h("div", { class: "ts", text: r.symbol }), h("div", { class: "tc " + dir(r.change_pct), text: fmt.pct(r.change_pct) }));
    grid.append(withTip(tile, () => [tipHead(r.symbol), tipRow("Close", fmt.px(r.close)), tipRow("Change", fmt.pct(r.change_pct)),
      tipRow("Call", `${CALLS[r.call].text.toLowerCase()} · ${r.label}`), tipRow("ATR", fmt.pct0(r.atr_pct, 2)),
      tipRow("Chance of up close", fmt.prob(r.p_up, 0)), tipRow("Trend health", ok(r.health) ? String(Math.round(r.health)) : "-")]));
  });
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Nifty 50 at the last close" }),
      h("div", { class: "heat-key" }, "fell", h("span", { class: "ramp" }), "rose", h("i", { class: "tk", style: { position: "static", display: "inline-block", marginLeft: "10px" } }), "has a plan")),
    h("div", { class: "card-b" }, grid));
}

function contextCard(market) {
  const tile = (label, value, note, cls) => h("div", { class: "stat" }, h("div", { class: "sl", text: label }), h("div", { class: "sv " + (cls || ""), text: value }), h("div", { class: "sn", text: note }));
  const v = market.valuation, b = market.breadth, x = market.vix;
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Market context" }), h("span", { class: "hint", text: "Overnight markets feed the forecast; the rest is background" })),
    h("div", { class: "card-b" }, h("div", { class: "ctx" },
      market.overnight.map((o) => tile(o.label.toUpperCase(), fmt.pct(o.change_pct), `${fmt.px(o.close)} · ${fmtDate(o.date)}`, dir(o.change_pct))),
      tile("INDIA VIX", fmt.num(x.level, 2), `${x.regime} · ${fmt.pct0(x.percentile)} of the past year`),
      tile("ADVANCERS", fmt.pct0(b.advance_pct), `10-day average ${fmt.pct0(b.advance_pct_10d)}`),
      tile("ABOVE 50-DAY AVG", fmt.pct0(b.above_sma50_pct), "share of Nifty 50 stocks"),
      v ? tile("NIFTY P/E", fmt.num(v.pe, 1), `${fmt.pct0(v.pe_percentile)} percentile since ${v.since.slice(0, 4)}`) : null,
      v ? tile("NIFTY P/B", fmt.num(v.pb, 2), `${fmt.pct0(v.pb_percentile)} percentile · yield ${fmt.num(v.div_yield, 2)}%`) : null)));
}
