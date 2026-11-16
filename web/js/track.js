// Track record: the scoreboard. Live and backtest are always kept apart.
import { calibrationChart, lineChart } from "./charts.js";
import { clear, fmt, fmtDate, getJSON, h, ok, prefs, reveal, tipHead, tipNote, withTip } from "./core.js";

const RULES = { breakout: "Breakout", pullback: "Dip buy", gap_reversal: "Gap reversal" };
const ci = (c) => (c ? `95% range ${fmt.prob(c[0], 1)} to ${fmt.prob(c[1], 1)}` : "");
const early = () => h("span", { class: "early", text: "too early" });

export async function renderTrack(root) {
  const [track, learning] = await Promise.all([getJSON("track.json"), getJSON("learning.json", { optional: true })]);
  const liveN = (track.live && track.live.aggregate.scored) || 0;
  let which = prefs.get("track", liveN >= track.min_n ? "live" : "backtest");
  if (which === "backtest" && !track.backtest) which = "live";

  const body = h("div", { class: "stack" });
  const seg = h("div", { class: "seg", role: "tablist" }, ["live", "backtest"].map((k) =>
    h("button", { type: "button", class: which === k ? "on" : "", role: "tab", "aria-selected": which === k,
      text: k === "live" ? `Live (${fmt.int(liveN)})` : "Backtest", disabled: k === "backtest" && !track.backtest,
      onclick: (e) => { which = k; prefs.set("track", k); seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget)); draw(); } })));
  const draw = () => { clear(body).append(...board(track[which], which, track.min_n), learningCard(learning)); reveal(body); };   // `body` stays on the page; `root` is emptied by the router

  clear(root).append(
    h("div", { class: "page-h" },
      h("div", {}, h("h1", { text: "Track record" }),
        h("p", { text: "Every plan is written down before the market opens and scored against the official close data. The numbers below are allowed to say there is no edge." })),
      seg),
    body);
  draw();
}

function board(t, which, minN) {
  if (!t) return [h("div", { class: "card headline reveal", text: "No backtest has been published yet." })];
  const a = t.aggregate, out = [];
  const note = h("div", { class: "card reveal", style: { padding: "12px 16px" } },
    h("span", { class: "pill " + (which === "live" ? "good" : "amber"), text: t.label }), " ",
    h("span", { class: "sub", text: t.note }),
    a.first ? h("span", { class: "muted", text: `  ${fmtDate(a.first)} to ${fmtDate(a.last)} · ${fmt.int(a.days)} sessions · ${fmt.int(a.scored)} predictions${a.void ? ` · ${a.void} void` : ""}` }) : null);
  out.push(note);
  if (!a.scored || !a.direction) {
    out.push(h("div", { class: "card headline reveal" }, h("b", { text: "Nothing scored yet. " }),
      "The first live result appears after the first trading day on which a plan was committed at 06:00 IST. Until then the Backtest tab shows how the same code would have done."));
    return out;
  }
  const d = a.direction, r = a.ranges, tooEarly = a.scored < minN;

  // Headline sentence adapts to the numbers.
  const skillLo = d.skill_days && d.skill_days.ci ? d.skill_days.ci[0] : null;
  const verdict = tooEarly ? "too early to say anything"
    : skillLo != null && skillLo > 0 ? "a small edge that is unlikely to be luck"
    : d.skill > 0 ? "slightly better than the base rate, but the difference could be luck" : "no reliable edge";
  out.push(h("div", { class: "card headline reveal" },
    "Direction was right ", h("b", { text: fmt.prob(d.hit.rate, 1) }), ` of the time (${ci(d.hit.ci)}, n = ${fmt.int(d.hit.n)}) against `,
    h("b", { text: fmt.prob(d.always_up_hit, 1) }), ' for always saying "up": ', h("b", { text: verdict }), ". The 90% range for the close contained the real close ",
    h("b", { text: fmt.prob(r.close.rate, 1) }), " of the time."));

  const kpi = (label, value, note, extra, tip) => {
    const el = h("div", { class: "card kpi lift reveal", tabindex: 0 }, h("div", { class: "eyebrow", text: label }),
      h("div", { class: "kv1", text: value }), h("div", { class: "kn", text: note }), extra ? h("div", { class: "kc", text: extra }) : null);
    return tip ? withTip(el, () => [tipHead(label), tipNote(tip)]) : el;
  };
  out.push(h("div", { class: "tiles" },
    kpi("Direction hit rate", tooEarly ? "-" : fmt.prob(d.hit.rate, 1), `vs ${fmt.prob(d.always_up_hit, 1)} for "always up"`, ci(d.hit.ci),
      "How often the side the tool leaned to (above or below 50%) matched the close. Next-day direction for any honest method sits between 50% and 55%."),
    kpi("Direction skill", tooEarly ? "-" : fmt.pct(d.skill * 100, 2), "Brier skill vs the base rate", d.skill_days && d.skill_days.ci ? `per-day range ${fmt.signed(d.skill_days.ci[0], 4)} to ${fmt.signed(d.skill_days.ci[1], 4)}` : "",
      "1 minus (the tool's Brier score / the score of always quoting the stock's historical up-rate). Above zero means the probabilities carried information."),
    kpi("90% range coverage", tooEarly ? "-" : fmt.prob(r.close.rate, 1), "target 90%", ci(r.close.ci),
      "Share of sessions where the real close fell inside the predicted 90% range. Close to 90% means the range is honest: not too narrow, not too wide."),
    kpi("Average range width", fmt.pct0(r.avg_width, 2), `gap ${fmt.prob(r.gap.rate, 1)} · session range ${fmt.prob(r.session_range.rate, 1)}`, "coverage of the other two ranges",
      "Width of the 90% range for the close, in percent of price. Narrower is more useful, as long as coverage stays near 90%."),
    kpi("Touch-level skill", a.touch ? fmt.pct(a.touch.skill_vs_constant * 100, 1) : "-", "vs quoting one constant chance", a.touch ? `${fmt.int(a.touch.n)} level forecasts` : "",
      "Four levels per stock per day (half an ATR up and down, yesterday's high and low). Skill above zero means the quoted chances separated likely from unlikely touches.")));

  // Calibration
  const c1 = h("div", { class: "chart" }), c2 = h("div", { class: "chart" });
  if (a.touch) calibrationChart(c1, a.touch.calibration, { what: "Quoted" });
  calibrationChart(c2, d.calibration, { lo: 0.3, hi: 0.7, what: "Quoted up" });
  out.push(h("div", { class: "grid2" },
    h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "Were the touch chances honest?" }), h("span", { class: "hint", text: "Dots on the line = well calibrated" })), h("div", { class: "chart-wrap" }, c1)),
    h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "Were the up/down chances honest?" }), h("span", { class: "hint", text: "Zoomed to 30% to 70%" })), h("div", { class: "chart-wrap" }, c2))));

  // Rules
  const blocks = [["breakout", "s1"], ["pullback", "s2"], ["gap_reversal", "s3"]].map(([k, cls]) => ({ k, cls, b: a.rules[k], name: RULES[k] }));
  blocks.push({ k: "baseline", cls: "base", b: a.baseline, name: "Buy every open (naive)" });
  const eq = h("div", { class: "chart" });
  lineChart(eq, blocks.filter((x) => x.b && x.b.equity_r).map((x) => ({ name: x.name, cls: x.cls, points: x.b.equity_r })));
  const row = (name, b, strong) => {
    const m = b && b.mean_r;
    return h("tr", {}, h("td", {}, strong ? h("b", { text: name }) : name),
      h("td", { class: "n", text: b ? fmt.int(b.plans) : "-" }), h("td", { class: "n", text: b ? fmt.int(b.trades) : "-" }),
      h("td", { class: "n", text: b && b.win ? fmt.prob(b.win.rate) : "-" }),
      h("td", { class: "n " + (m && ok(m.mean) ? (m.mean > 0 ? "up" : "down") : "") }, m ? (m.too_early ? early() : fmt.r(m.mean, 3)) : "-"),
      h("td", { class: "n muted", text: m && m.ci ? `${fmt.signed(m.ci[0], 2)} to ${fmt.signed(m.ci[1], 2)}` : "-" }),
      h("td", { class: "n", text: b && ok(b.total_r) ? fmt.r(b.total_r, 0) : "-" }));
  };
  out.push(h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Plan rules after costs" }), h("span", { class: "hint", text: "R = amount risked per trade. Zero is not trading at all." })),
    h("div", { class: "chart-wrap" }, eq),
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "k1" }), "Breakout"), h("span", {}, h("i", { class: "k2" }), "Dip buy"), h("span", {}, h("i", { class: "k3" }), "Gap reversal"), h("span", {}, h("i", { class: "kb" }), "Buy every open (naive)")),
    h("div", { class: "card-b scroll" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, h("th", { text: "RULE" }), h("th", { class: "n", text: "PLANS" }), h("th", { class: "n", text: "TRADES" }), h("th", { class: "n", text: "WIN RATE" }),
        h("th", { class: "n", text: "AVG PER TRADE" }), h("th", { class: "n", text: "95% RANGE" }), h("th", { class: "n", text: "TOTAL" }))),
      h("tbody", {}, blocks.map((x) => row(x.name, x.b)), row("Plans the tool actually called", a.called, true)))),
    h("div", { class: "card-b", style: { paddingTop: 0 } }, h("p", { class: "muted small",
      text: `Calls made: ${Object.entries(a.calls || {}).map(([k, v]) => `${k.replace("_", " ").toLowerCase()} ${fmt.int(v)}`).join(" · ")}. The interval is day-clustered: stocks on the same day move together, so each day counts once.` }))));

  // By symbol
  out.push(symbolTable(t.by_symbol));
  return out;
}

function symbolTable(bySym) {
  const rows = Object.entries(bySym || {}).map(([sym, v]) => ({ sym, ...v }));
  let key = "dir_hit", desc = true;
  const tbody = h("tbody");
  const draw = () => {
    clear(tbody);
    rows.sort((a, b) => (key === "sym" ? a.sym.localeCompare(b.sym) : a[key] - b[key]) * (desc ? -1 : 1));
    for (const r of rows)
      tbody.append(h("tr", { class: "click", onclick: () => { location.hash = `#/today?s=${encodeURIComponent(r.sym)}`; } },
        h("td", {}, h("b", { text: r.sym })), h("td", { class: "n", text: fmt.int(r.n) }),
        h("td", { class: "n" }, r.too_early ? early() : fmt.prob(r.dir_hit, 1)), h("td", { class: "n" }, r.too_early ? early() : fmt.prob(r.coverage, 1))));
  };
  const th = (label, k, n) => h("th", { class: "sort" + (n ? " n" : ""), text: label, onclick: () => { desc = key === k ? !desc : k !== "sym"; key = k; draw(); } });
  draw();
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "By stock" }), h("span", { class: "hint", text: "Click a column to sort, a row to open the stock" })),
    h("div", { class: "card-b scroll" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, th("STOCK", "sym"), th("PREDICTIONS", "n", true), th("DIRECTION HIT", "dir_hit", true), th("90% COVERAGE", "coverage", true))), tbody)));
}

function learningCard(L) {
  if (!L || !L.trained) {
    return h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "Weekly self-training" })),
      h("div", { class: "card-b muted", text: "No trained model yet: there is not enough history." }));
  }
  const w = L.blend_weights, total = (w.simple + w.logistic + w.trees) || 1;
  const seg = (cls, label, v) => (v / total > 0.02 ? h("div", { class: cls, style: { flex: `${v} 1 0` }, text: v / total > 0.14 ? `${label} ${fmt.prob(v / total)}` : "" }) : null);
  const names = { simple: "Plain history + overnight move", logistic: "Logistic model (retrained weekly)", trees: "Tree model (retrained weekly)", blend: "What the site uses (weighted blend)" };
  const maxW = Math.max(...L.top_weights.map((x) => Math.abs(x.weight)), 1e-9);
  const hist = L.history || [];
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Weekly self-training" }),
      h("span", { class: "hint", text: `Trained for the week of ${fmtDate(L.trained.week)} · next training ${fmtDate(L.next_training)}` })),
    h("div", { class: "card-b grid2" },
      h("div", { style: { display: "grid", gap: "12px", alignContent: "start", gridTemplateColumns: "minmax(0, 1fr)", minWidth: "0" } },
        h("p", { class: "sub", text: L.how }),
        h("div", {}, h("div", { class: "eyebrow", text: "How much each source counts this week" }),
          h("div", { class: "blend", style: { marginTop: "6px" } }, seg("b1", "History", w.simple), seg("b2", "Logistic", w.logistic), seg("b3", "Trees", w.trees)),
          h("div", { class: "legend", style: { padding: "6px 0 0" } }, h("span", {}, h("i", { class: "sw", style: { background: "var(--s1)" } }), `Plain history ${fmt.num(w.simple, 2)}`),
            h("span", {}, h("i", { class: "sw", style: { background: "var(--s2)" } }), `Logistic ${fmt.num(w.logistic, 2)}`), h("span", {}, h("i", { class: "sw", style: { background: "var(--s3)" } }), `Trees ${fmt.num(w.trees, 2)}`))),
        h("table", { class: "tbl", style: { tableLayout: "auto" } }, h("thead", {}, h("tr", {}, h("th", { style: { whiteSpace: "normal" }, text: `LAST ${L.window_sessions} SESSIONS, OUT OF SAMPLE` }), h("th", { class: "n", text: "HIT RATE" }), h("th", { class: "n", text: "SKILL VS COIN" }))),
          h("tbody", {}, Object.entries(names).map(([k, label]) => { const s = L.sources[k]; return h("tr", {}, h("td", {}, k === "blend" ? h("b", { text: label }) : label),
            h("td", { class: "n", text: s ? fmt.prob(s.hit, 1) : "-" }), h("td", { class: "n", text: s ? fmt.pct(s.skill_vs_coin * 100, 2) : "-" })); }))),
        h("p", { class: "muted small", text: `Trained on ${fmt.int(L.trained.rows)} stock-days from ${fmtDate(L.trained.from)} to ${fmtDate(L.trained.to)}. ${hist.length} training week${hist.length === 1 ? "" : "s"} logged so far.` })),
      h("div", { style: { minWidth: "0" } }, h("div", { class: "eyebrow", text: "What the logistic model leans on most" }),
        h("div", { class: "weights", style: { marginTop: "8px" } }, L.top_weights.map((x) => h("div", { class: "wrow2" },
          h("span", { text: x.label }),
          h("div", { class: "wbar" }, h("i", { class: x.weight >= 0 ? "pos" : "neg", style: { width: (Math.abs(x.weight) / maxW) * 50 + "%" } })),
          h("b", { class: "num", style: { textAlign: "right" }, text: fmt.signed(x.weight, 3) })))),
        h("p", { class: "muted small", style: { marginTop: "10px" }, text: "Bars to the right push the chance of an up close higher, bars to the left push it lower, per one standard deviation of that input. These weights are small: next-day direction is mostly noise." }))));
}
