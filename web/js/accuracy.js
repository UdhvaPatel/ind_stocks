// "Accuracy check": the forecast drawn against what the market really did, in plain words.
import { compareChart, scoreChart } from "./charts.js";
import { allRows, marketSeries, PERIODS, stockSeries, summarize, verdict } from "./comparelogic.js";
import { clear, countUp, fmt, fmtDate, getJSON, h, icon, prefs, reveal, withTip, tipHead, tipNote } from "./core.js";
import { openHelp } from "./guide.js";

const ALL = "ALL";

export async function renderAccuracy(root, ctx) {
  const { params, go } = ctx;
  const data = await getJSON("compare.json", { optional: true });
  clear(root);
  root.append(h("div", { class: "page-h" },
    h("div", {}, h("h1", { text: "Prediction vs real market" }),
      h("p", { text: "Every morning the tool writes down a range where it expects each stock to close. Every evening the real close comes in. This page puts the two side by side, so you can see for yourself how close it got." }))));
  if (!data || !data.days || !data.days.length) {
    root.append(h("div", { class: "card headline", text: "No scored days have been published yet. The first comparison appears after the first evening update." }));
    return;
  }

  const symbols = Object.keys(data.stocks);
  const state = {
    sym: symbols.includes(params.get("s")) ? params.get("s") : params.get("s") === ALL ? ALL : prefs.get("acc-sym", ALL),
    period: PERIODS[params.get("p")] ? params.get("p") : prefs.get("acc-period", "60"),
    unit: params.get("u") === "pct" ? "pct" : prefs.get("acc-unit", "inr"),
  };
  if (state.sym !== ALL && !symbols.includes(state.sym)) state.sym = ALL;
  if (!PERIODS[state.period]) state.period = "60";

  const live = data.track.filter((t) => t === "live").length;
  root.append(guideCard(live, data.days.length, go));

  const body = h("div", { class: "stack" });
  const unitSeg = h("div", { class: "seg", role: "tablist", "aria-label": "Show prices or percent" });
  const periodChips = h("div", { class: "chips" });
  const select = h("select", { class: "acc-select", "aria-label": "Choose a stock", onchange: (e) => { state.sym = e.target.value; update(); } },
    h("option", { value: ALL, text: "All 50 stocks together" }), symbols.map((s) => h("option", { value: s, text: s })));
  select.value = state.sym;

  const drawControls = () => {
    clear(periodChips).append(...Object.entries(PERIODS).map(([k, label]) => h("button", { class: "chip" + (state.period === k ? " on" : ""), type: "button", text: label,
      onclick: () => { state.period = k; update(); } })));
    clear(unitSeg).append(...[["inr", "₹ Prices"], ["pct", "% Change"]].map(([k, label]) => h("button", { type: "button", class: state.unit === k ? "on" : "", role: "tab", "aria-selected": state.unit === k,
      disabled: state.sym === ALL, text: label, onclick: () => { state.unit = k; update(); } })));
  };
  const update = () => {
    prefs.set("acc-sym", state.sym); prefs.set("acc-period", state.period); prefs.set("acc-unit", state.unit);
    try { history.replaceState(null, "", `#/accuracy?s=${encodeURIComponent(state.sym)}&p=${state.period}&u=${state.unit}`); } catch (e) { /* not in a browser */ }
    drawControls();
    clear(body).append(...(state.sym === ALL ? marketView(data, state, go, pick) : stockView(data, state, go)));
    reveal(body);
  };
  const pick = (sym) => { state.sym = sym; select.value = sym; update(); };

  root.append(h("section", { class: "card acc-controls" },
    h("div", { class: "card-b" },
      h("div", { class: "acc-row" },
        h("label", { class: "acc-field" }, h("span", { class: "eyebrow", text: "1 · Pick a stock" }), select),
        h("div", { class: "acc-field" }, h("span", { class: "eyebrow", text: "2 · Pick a period" }), periodChips),
        h("div", { class: "acc-field" }, h("span", { class: "eyebrow", text: "3 · Show as" }), unitSeg)))),
    body);
  update();
}

// --------------------------------------------------------------- how to read
function guideCard(live, total, go) {
  const item = (swatch, title, text) => h("div", { class: "acc-key" }, swatch, h("div", {}, h("b", { text: title }), h("p", { text })));
  return h("section", { class: "card acc-guide" },
    h("div", { class: "card-b" },
      h("div", { class: "acc-keys" },
        item(h("span", { class: "sw-band", "aria-hidden": "true" }), "Blue bar = the prediction", "The range written down before that day. The tool expects the close to land inside it 9 days out of 10. The small line across it is the single most likely close."),
        item(h("span", { class: "sw-dot in", "aria-hidden": "true" }), "Green dot = landed inside", "The real closing price fell inside the predicted range. The prediction held."),
        item(h("span", { class: "sw-dot out", "aria-hidden": "true" }), "Red dot = landed outside", "The market moved more than expected. About 1 day in 10 should look like this; many more means the ranges are too narrow."),
        item(h("span", { class: "sw-line", "aria-hidden": "true" }), "Line = the real price", "How the stock actually moved, day by day.")),
      h("p", { class: "muted small acc-note" },
        h("span", { class: "pill good", text: `${live} live day${live === 1 ? "" : "s"}` }), " ",
        h("span", { class: "pill amber", text: `${total - live} backtest days` }), " ",
        `Live days (shaded) were predicted before the market opened; they are the ones that really count. Backtest days were replayed afterwards by the same code using only the data available before each day, so you have something to compare from the start. `,
        h("button", { class: "linkish", type: "button", text: "What do these words mean?", onclick: () => openHelp(go) }))));
}

// ------------------------------------------------------------------- tiles
function tiles(s, unit, who) {
  const tile = (label, to, format, note, cls, tip) => {
    const v = h("div", { class: "kv1 " + (cls || "") });
    countUp(v, to, format, 800);
    const el = h("div", { class: "card kpi lift reveal", tabindex: 0 }, h("div", { class: "eyebrow", text: label }), v, h("div", { class: "kn", text: note }));
    return tip ? withTip(el, () => [tipHead(label), tipNote(tip)]) : el;
  };
  const big = s.biggest;
  return h("div", { class: "tiles" },
    tile("DAYS COMPARED", s.n, (v) => fmt.int(Math.round(v)), who === "all" ? `${s.days} days × stocks` : `${s.live} live`, "",
      "Each comparison is one stock on one day: the prediction made before the day against the real close."),
    tile("CLOSE INSIDE THE RANGE", s.coverage * 100, (v) => Math.round(v) + "%", `${s.inside} of ${s.n} · aim 90%`, s.coverage >= 0.86 ? "up" : "down",
      "How often the real close landed inside the predicted range. Near 90% means the ranges are honest."),
    tile("UP/DOWN LEAN RIGHT", s.hit == null ? null : s.hit * 100, (v) => Math.round(v) + "%", `plain guess: ${Math.round(Math.max(s.alwaysUp, 1 - s.alwaysUp) * 100)}%`, "",
      "Above 50% chance of up counts as leaning up. Compare it with simply guessing the more common direction every day."),
    tile("AVERAGE MISS", unit === "inr" && who !== "all" ? s.avgMissRs : s.avgMissPct, (v) => (unit === "inr" && who !== "all" ? "₹" + fmt.num(v, 2) : fmt.num(v, 2) + "%"),
      unit === "inr" && who !== "all" ? `${fmt.num(s.avgMissPct, 2)}% of the price` : "between most-likely and real close", "",
      "The gap between the single most likely close and the real close, averaged. Smaller is better."),
    tile("TYPICAL RANGE WIDTH", s.avgWidth, (v) => fmt.num(v, 1) + "%", "from bottom to top of the bar", "",
      "A narrower range is more useful, as long as the close still lands inside it about 9 times in 10."),
    tile("LANDED ABOVE / BELOW", s.above + s.below, (v) => `${s.above} / ${s.below}`, "times outside: rose too much / fell too much", "",
      big ? `Biggest surprise: ${big.symbol ? big.symbol + " on " : ""}${fmtDate(big.date)}, closed ${fmt.pct(big.ret)} against a range of ${fmt.pct(big.p05, 1)} to ${fmt.pct(big.p95, 1)}.` : ""));
}

function verdictCard(s, who) {
  const v = verdict(s, who);
  const tone = { good: "good", wide: "amber", narrow: "bad", early: "", none: "" };
  const dirTone = { good: "good", even: "amber", worse: "bad", early: "", none: "" };
  const label = { good: "Ranges honest", wide: "Ranges a bit wide", narrow: "Ranges too narrow", early: "Too early", none: "No data" };
  const dirLabel = { good: "Lean helped", even: "Lean ≈ a guess", worse: "Lean worse than a guess", early: "Too early", none: "" };
  return h("section", { class: "card reveal acc-verdict" },
    h("div", { class: "card-b" },
      h("div", { class: "acc-v-row" }, h("span", { class: "pill " + tone[v.grade], text: label[v.grade] }), h("p", { text: v.range })),
      v.direction ? h("div", { class: "acc-v-row" }, h("span", { class: "pill " + dirTone[v.dirGrade], text: dirLabel[v.dirGrade] }), h("p", { text: v.direction })) : null,
      h("p", { class: "muted small", text: "Next-day direction is close to a coin flip for any honest method, so expect the lean to be right only a little over half the time. The range is the more useful part." })));
}

// --------------------------------------------------------------- one stock
function stockView(data, state, go) {
  const rows = stockSeries(data, state.sym, state.period);
  if (!rows.length) return [h("div", { class: "card headline", text: `No scored days for ${state.sym} in this period.` })];
  const s = summarize(rows);
  const el = h("div", { class: "chart" });
  const chart = compareChart(el, rows, { unit: state.unit, onPick: (r) => go("archive", { date: r.date }) });
  const strip = h("div", { class: "hitstrip", role: "list", "aria-label": "Each day: inside the range or not" }, rows.map((r, i) => {
    const cell = h("button", { class: "hs " + (r.inside ? "in" : "out") + (r.track === "live" ? " live" : ""), type: "button", role: "listitem", style: { animationDelay: Math.min(i * 10, 600) + "ms" },
      "aria-label": `${fmtDate(r.date)}: ${r.inside ? "inside" : "outside"} the range`, onclick: () => go("archive", { date: r.date }),
      onpointerenter: () => chart.highlight(i), onpointerleave: () => chart.highlight(-1), onfocus: () => chart.highlight(i), onblur: () => chart.highlight(-1) },
      h("i", { class: r.right == null ? "" : r.right ? "r" : "w" }));
    return cell;
  }));
  const recent = rows.slice(-15).reverse();
  const table = h("table", { class: "tbl acc-tbl" },
    h("thead", {}, h("tr", {}, h("th", { text: "DAY" }), h("th", { class: "n", text: "PREDICTED RANGE" }), h("th", { class: "n", text: "MOST LIKELY" }), h("th", { class: "n", text: "REAL CLOSE" }),
      h("th", { class: "n", text: "MOVE" }), h("th", { text: "RESULT" }))),
    h("tbody", {}, recent.map((r) => {
      const i = rows.indexOf(r);
      return h("tr", { class: "click", tabindex: 0, onclick: () => go("archive", { date: r.date }), onkeydown: (e) => { if (e.key === "Enter") go("archive", { date: r.date }); },
        onpointerenter: () => chart.highlight(i), onpointerleave: () => chart.highlight(-1) },
        h("td", {}, fmtDate(r.date, true), r.track === "live" ? h("span", { class: "pill good", style: { marginLeft: "6px" }, text: "live" }) : null),
        h("td", { class: "n", text: `₹${fmt.px(r.lo)} – ₹${fmt.px(r.hi)}` }),
        h("td", { class: "n", text: "₹" + fmt.px(r.mid) }),
        h("td", { class: "n" }, h("b", { text: "₹" + fmt.px(r.close) })),
        h("td", { class: "n " + (r.ret > 0 ? "up" : r.ret < 0 ? "down" : ""), text: fmt.pct(r.ret) }),
        h("td", {}, h("span", { class: "check " + (r.inside ? "ok" : "no"), style: { display: "inline-grid", padding: "2px 8px" } }, icon(r.inside ? "check" : "cross"), h("span", { text: r.inside ? "inside" : "outside" })),
          r.right == null ? null : h("span", { class: "muted small", style: { marginLeft: "8px" }, text: r.right ? "lean right" : "lean wrong" })));
    })));
  return [
    verdictCard(s, state.sym),
    tiles(s, state.unit, state.sym),
    h("section", { class: "card reveal" },
      h("div", { class: "card-h" }, h("h3", { text: `${state.sym}: what the tool predicted vs what really happened` }),
        h("span", { class: "hint", text: state.unit === "inr" ? "Rupees · hover a day for details, click to open it" : "% change from the previous close" })),
      h("div", { class: "chart-wrap" }, el),
      h("div", { class: "legend" },
        h("span", {}, h("i", { class: "sw", style: { background: "var(--s1)", opacity: ".45" } }), "predicted 90% range"),
        h("span", {}, h("i", { class: "sw", style: { background: "var(--text-2)", height: "2px" } }), "most likely close"),
        state.unit === "inr" ? h("span", {}, h("i", { class: "k3" }), "real price") : null,
        h("span", {}, h("i", { class: "sw", style: { background: "var(--up)", borderRadius: "50%" } }), "close inside"),
        h("span", {}, h("i", { class: "sw", style: { background: "var(--down)", borderRadius: "50%" } }), "close outside"),
        h("span", {}, h("i", { class: "sw live-sw" }), "live day"))),
    h("section", { class: "card reveal" },
      h("div", { class: "card-h" }, h("h3", { text: "Day by day" }), h("span", { class: "hint", text: "Square: green inside, red outside · dot: up/down lean right (white) or wrong (dark)" })),
      h("div", { class: "card-b" }, strip,
        h("p", { class: "muted small", style: { marginTop: "8px" }, text: `${s.insideStreak ? `The last ${s.insideStreak} day${s.insideStreak === 1 ? "" : "s"} in a row landed inside the range. ` : ""}Hover a square to find that day on the chart; click to open it in the Archive.` }))),
    h("section", { class: "card reveal" },
      h("div", { class: "card-h" }, h("h3", { text: "The last 15 days in numbers" }), h("span", { class: "hint", text: "Newest first · click a row to see every stock that day" })),
      h("div", { class: "card-b scroll-x" }, table)),
    nextSteps(go, state.sym),
  ];
}

// ------------------------------------------------------------ whole market
function marketView(data, state, go, pick) {
  const series = marketSeries(data, state.period);
  const rows = allRows(data, state.period);
  const s = summarize(rows);
  if (!s) return [h("div", { class: "card headline", text: "No scored days in this period." })];
  const el = h("div", { class: "chart" });
  scoreChart(el, series);
  // Stocks ranked by how often their close landed inside the range.
  const bySym = Object.keys(data.stocks).map((sym) => ({ sym, s: summarize(stockSeries(data, sym, state.period)) })).filter((x) => x.s)
    .sort((a, b) => b.s.coverage - a.s.coverage || a.sym.localeCompare(b.sym));
  const rank = (title, list, cls) => h("div", { class: "movers" }, h("div", { class: "eyebrow", text: title }),
    list.map((x, i) => h("button", { class: "mover", type: "button", style: { animationDelay: i * 50 + "ms" }, onclick: () => pick(x.sym), "aria-label": `${x.sym}: ${Math.round(x.s.coverage * 100)}% inside` },
      h("span", { class: "mv-s", text: x.sym }), h("span", { class: "mv-bar " + cls }, h("i", { vars: { "--v": x.s.coverage } })),
      h("span", { class: "mv-c " + cls, text: Math.round(x.s.coverage * 100) + "%" }))));
  return [
    verdictCard(s, "all 50 stocks"),
    tiles(s, "pct", "all"),
    h("section", { class: "card reveal" },
      h("div", { class: "card-h" }, h("h3", { text: "Every day, all 50 stocks: how many predictions held?" }), h("span", { class: "hint", text: "Hover a day for details" })),
      h("div", { class: "chart-wrap" }, el),
      h("div", { class: "legend" },
        h("span", {}, h("i", { class: "sw", style: { background: "var(--s1)", opacity: ".55" } }), "share of closes inside their range (bar)"),
        h("span", {}, h("i", { class: "k2" }), "share of up/down leans that were right (line)"),
        h("span", {}, h("i", { class: "sw", style: { background: "var(--up)", height: "2px" } }), "aim: 90%"),
        h("span", {}, h("i", { class: "sw", style: { background: "var(--muted)", height: "2px" } }), "coin flip: 50%"),
        h("span", {}, h("i", { class: "sw live-sw" }), "live day")),
      h("p", { class: "muted small", style: { padding: "0 16px 14px" }, text: "Some days most stocks fall outside their ranges together: that is usually a day when the whole market moved sharply. Stocks move together, so one bad day hits many predictions at once." })),
    h("section", { class: "card reveal" },
      h("div", { class: "card-h" }, h("h3", { text: "Which stocks were predicted best?" }), h("span", { class: "hint", text: "Share of days the close landed inside the range · click a stock to see its chart" })),
      h("div", { class: "card-b grid2" }, rank("Most often inside", bySym.slice(0, 6), "up"), rank("Least often inside", bySym.slice(-6).reverse(), "down"))),
    nextSteps(go, null),
  ];
}

function nextSteps(go, sym) {
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Other ways to check" })),
    h("div", { class: "card-b altgrid" },
      h("div", { class: "alt" }, h("b", { text: "One day, every stock" }), h("p", { text: "The Archive shows any single day: what was predicted that morning for all 50 stocks, and what happened that evening." }),
        h("button", { class: "btn", type: "button", text: "Open the Archive", onclick: () => go("archive") })),
      h("div", { class: "alt" }, h("b", { text: "The full scoreboard" }), h("p", { text: "Track record has the detailed statistics: confidence ranges, calibration charts and how the plan rules did after costs." }),
        h("button", { class: "btn", type: "button", text: "Open Track record", onclick: () => go("track") })),
      sym ? h("div", { class: "alt" }, h("b", { text: `Today's plan for ${sym}` }), h("p", { text: "See the levels and the forecast the tool has written down for the next session." }),
        h("button", { class: "btn", type: "button", text: `Open ${sym}`, onclick: () => go("today", { s: sym }) })) : null));
}
