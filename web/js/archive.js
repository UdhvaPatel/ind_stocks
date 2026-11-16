// Day archive: for any past session, what was predicted, what happened, and how it scored.
import { clear, countUp, dir, fmt, fmtDate, fmtStampIST, getJSON, h, icon, ok, reveal } from "./core.js";

const RULES = { breakout: "Breakout", pullback: "Dip buy", gap_reversal: "Gap reversal" };
const OUT = { not_triggered: ["not triggered", ""], cancelled: ["cancelled", ""], none: ["no plan", ""], stopped: ["stopped", "bad"],
              t1: ["target 1", "good"], t2: ["target", "good"], time: ["time exit", null] };

export async function renderArchive(root, ctx) {
  const index = await getJSON("days/index.json", { optional: true });
  const days = index ? index.days.map((d) => d.date).sort() : [];
  if (!days.length) { clear(root).append(h("div", { class: "card headline", text: "No past sessions have been published yet." })); return; }
  let date = ctx.params.get("date");
  if (!days.includes(date)) date = days[days.length - 1];
  const i = days.indexOf(date);
  const day = await getJSON(`days/${date}/summary.json`);
  const s = day.summary;

  const select = h("select", { "aria-label": "Session date", onchange: (e) => ctx.go("archive", { date: e.target.value }) },
    days.slice().reverse().map((d) => h("option", { value: d, selected: d === date, text: fmtDate(d, true) })));
  const nav = h("div", { class: "daypick" },
    h("button", { class: "btn", type: "button", disabled: i === 0, text: "← Earlier", onclick: () => ctx.go("archive", { date: days[i - 1] }) }),
    select,
    h("button", { class: "btn", type: "button", disabled: i === days.length - 1, text: "Later →", onclick: () => ctx.go("archive", { date: days[i + 1] }) }));

  const kpi = (label, value, note, cls, numeric) => {
    const v = h("div", { class: "kv1 " + (cls || "") });
    if (numeric) countUp(v, numeric.to, numeric.f); else v.textContent = value;
    return h("div", { class: "card kpi lift reveal" }, h("div", { class: "eyebrow", text: label }), v, h("div", { class: "kn", text: note }));
  };
  const scored = day.rows.filter((r) => r.status === "scored");
  const made = scored.find((r) => r.made_at);
  const traded = scored.filter((r) => r.plan && ok(r.plan.outcome.r));

  const tbody = h("tbody");
  for (const r of day.rows) {
    if (r.status !== "scored") {
      tbody.append(h("tr", {}, h("td", {}, h("b", { text: r.symbol })), h("td", { colspan: 7, class: "muted", text: `Void: ${r.reason}` })));
      continue;
    }
    const act = r.actual.ret_pct;
    let mini = "-";
    if (r.range) {
      const [p05, , p95] = r.range, lo = Math.min(p05, act, -4), hi = Math.max(p95, act, 4), X = (v) => ((v - lo) / (hi - lo)) * 100;
      mini = h("div", { class: "mini", title: `Predicted ${fmt.pct(p05, 1)} to ${fmt.pct(p95, 1)}, actual ${fmt.pct(act)}` },
        h("div", { class: "mt" }), h("div", { class: "mb", style: { left: X(p05) + "%", width: X(p95) - X(p05) + "%" } }),
        h("div", { class: "ma", style: { left: X(act) + "%", background: act >= 0 ? "var(--up)" : "var(--down)" } }));
    }
    const mark = (flag) => (flag == null ? "-" : h("span", { class: "check " + (flag ? "ok" : "no"), style: { display: "inline-grid", padding: 0, border: 0, background: "none" } }, icon(flag ? "check" : "cross")));
    let outcome = "-";
    if (r.plan) {
      const o = r.plan.outcome, [text, tone] = OUT[o.status] || [o.status, ""];
      const cls = tone == null ? (o.r > 0 ? "good" : "bad") : tone;
      outcome = h("span", { class: "pill " + cls, text: `${RULES[r.plan.kind]}: ${text}${ok(o.r) ? " " + fmt.r(o.r) : ""}` });
    }
    const callCls = r.call.call === "FAVOURABLE" ? "good" : r.call.call === "NEUTRAL" ? "amber" : "";
    tbody.append(h("tr", { class: "click", onclick: () => ctx.go("today", { s: r.symbol }) },
      h("td", {}, h("b", { text: r.symbol })),
      h("td", {}, h("span", { class: "pill " + callCls, text: r.call.call.replace("_", " ").toLowerCase() })),
      h("td", { class: "n", text: fmt.prob(r.p_up, 0) }),
      h("td", { class: "n " + dir(act), text: fmt.pct(act) }),
      h("td", {}, mini), h("td", { class: "n" }, mark(r.dir_correct)), h("td", { class: "n" }, mark(r.inside)), h("td", {}, outcome)));
  }

  clear(root).append(
    h("div", { class: "page-h" },
      h("div", {}, h("h1", { text: fmtDate(date, true) }),
        h("p", {}, h("span", { class: "pill " + (day.track === "live" ? "good" : "amber"), text: day.track === "live" ? "Live (out of sample)" : "Backtest (not live)" }), " ",
          day.track === "live" ? `Predictions were committed before the open${made ? " at " + fmtStampIST(made.made_at) : ""} and scored against official NSE prices.`
            : "Replayed by the same code using only data available before that session. Prices are adjusted for later corporate actions.")),
      nav),
    h("div", { class: "tiles", style: { marginBottom: "16px" } },
      kpi("Market that day", "", `${fmt.prob(s.up_share)} of stocks closed up`, dir(s.avg_ret_pct), { to: s.avg_ret_pct, f: (v) => fmt.pct(v) }),
      kpi("Direction right", "", `${s.scored} stocks scored`, "", { to: (s.dir_hit || 0) * 100, f: (v) => v.toFixed(0) + "%" }),
      kpi("Inside the 90% range", "", "target 90%", "", { to: (s.coverage || 0) * 100, f: (v) => v.toFixed(0) + "%" }),
      kpi("Plans that traded", String(traded.length), traded.length ? `net ${fmt.r(traded.reduce((a, r) => a + r.plan.outcome.r, 0))} in total` : "none triggered")),
    h("section", { class: "card reveal" },
      h("div", { class: "card-h" }, h("h3", { text: "Every stock: predicted vs actual" }), h("span", { class: "hint", text: "Blue band = predicted 90% range, marker = actual close change" })),
      h("div", { class: "card-b scroll", style: { maxHeight: "none" } }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { text: "STOCK" }), h("th", { text: "CALL" }), h("th", { class: "n", text: "CHANCE UP" }), h("th", { class: "n", text: "ACTUAL" }),
          h("th", { text: "RANGE VS ACTUAL" }), h("th", { class: "n", text: "DIRECTION" }), h("th", { class: "n", text: "IN RANGE" }), h("th", { text: "REFERENCE OR CALLED PLAN" }))),
        tbody))));
  reveal(root);
}
