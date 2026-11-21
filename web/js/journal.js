// "My journal": paper trades a visitor chose to follow, scored from the published results.
import { lineChart } from "./charts.js";
import { clear, countUp, fmt, fmtDate, getJSON, h, reveal } from "./core.js";
import { RULE_TITLES } from "./homelogic.js";
import { load, remove, resolve, save, summary, toCSV } from "./journallogic.js";

const money = (x) => (x == null ? "-" : (x > 0 ? "+" : x < 0 ? "−" : "") + "₹" + Math.abs(Math.round(x)).toLocaleString("en-IN"));
const rs = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
const STATUS = {
  pending: ["Waiting for the result", "pend"], no_trade: ["Plan did not buy · ₹0", "flat"], gain: ["Gain", "up"], loss: ["Loss", "down"],
  unknown: ["Result not recorded yet", "flat"], no_data: ["No session that day", "flat"],
};

export async function renderJournal(root, ctx) {
  const { go } = ctx;
  const compare = await getJSON("compare.json", { optional: true });
  const body = h("div", { class: "jr-body" });
  const draw = () => {
    const list = load();
    const res = resolve(list, compare);
    clear(body).append(...view(res, summary(res), go, (id) => { save(remove(load(), id)); draw(); }, () => { save([]); draw(); }));
    reveal(body);
  };
  clear(root).append(
    h("div", { class: "page-h" }, h("div", {},
      h("h1", { text: "My paper-trading journal" }),
      h("p", { text: "Practise without risking money. On the Home page, press “I'd follow this plan” for any stock. After that market day closes, the journal shows what would have happened, using the same official results as the rest of the site." }))),
    body);
  draw();
}

function view(res, s, go, onRemove, onClear) {
  if (!res.length) {
    return [h("section", { class: "hx-card jr-empty" },
      h("div", { class: "jr-empty-i", "aria-hidden": "true", text: "📒" }),
      h("h3", { text: "Your journal is empty" }),
      h("p", { text: "Pick a stock on the Home page, read its plan for the next market day, and press “I'd follow this plan”. Come back after 6 PM India time on that day to see the result. Your journal is saved only in this browser." }),
      h("button", { class: "hx-btn", type: "button", onclick: () => go("home") }, "Go to Home", h("span", { class: "hx-arrow", text: "→" })))];
  }
  const tile = (label, to, format, note, cls) => {
    const v = h("b", { class: cls || "" });
    countUp(v, to, format, 800);
    return h("div", { class: "jr-tile" }, h("span", { text: label }), v, h("small", { text: note }));
  };
  const out = [h("div", { class: "jr-tiles" },
    tile("RESULT SO FAR", s.total, money, `${s.trades} trade${s.trades === 1 ? "" : "s"} settled`, s.total > 0 ? "up" : s.total < 0 ? "down" : ""),
    tile("WINS / LOSSES", s.wins, () => `${s.wins} / ${s.losses}`, s.trades ? `${Math.round((s.wins / s.trades) * 100)}% of trades gained` : "no trades yet"),
    tile("PLANS FOLLOWED", s.entries, (v) => String(Math.round(v)), `${s.noTrade} never bought · ${s.pending} waiting`),
    tile("AVERAGE PER TRADE", s.avgReturnPct, (v) => (s.avgReturnPct == null ? "-" : fmt.pct(v, 2)), "after charges", s.avgReturnPct > 0 ? "up" : s.avgReturnPct < 0 ? "down" : ""))];

  if (s.curve.length >= 2) {
    const el = h("div", { class: "chart" });
    lineChart(el, [{ name: "Your paper result", cls: "s3", points: s.curve }], { unit: (v) => money(v) });
    out.push(h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "Your paper result over time" }), h("span", { class: "hint", text: "running total after charges" })),
      h("div", { class: "chart-wrap" }, el)));
  }

  const rows = res.slice().sort((a, b) => b.forDate.localeCompare(a.forDate) || a.symbol.localeCompare(b.symbol));
  out.push(h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Every plan you followed" }), h("span", { class: "hint", text: "newest first" })),
    h("div", { class: "card-b jr-list" }, rows.map((e, i) => {
      const [label, tone] = STATUS[e.status] || [e.status, "flat"];
      return h("div", { class: "jr-row " + tone, style: { animationDelay: Math.min(i * 40, 400) + "ms" } },
        h("div", { class: "jr-when" }, h("b", { text: fmtDate(e.forDate, true) }), h("small", { text: `added ${fmtDate(e.addedAt)}` })),
        h("div", { class: "jr-what" }, h("b", { text: e.symbol }), h("small", { text: `${RULE_TITLES[e.kind] || e.kind} · ${rs(e.amount)}` })),
        h("div", { class: "jr-out" }, h("span", { class: "jr-pill " + tone, text: label }),
          e.money != null && e.status !== "no_trade" ? h("b", { class: tone, text: money(e.money) }) : null),
        h("button", { class: "jr-x", type: "button", "aria-label": `Remove ${e.symbol} on ${fmtDate(e.forDate)} from the journal`, text: "×", onclick: () => onRemove(e.id) }));
    }))));

  let armed = false;
  const clearBtn = h("button", { class: "hx-btn ghost small", type: "button", text: "Clear journal", onclick: () => {
    if (!armed) { armed = true; clearBtn.textContent = "Press again to delete everything"; clearBtn.classList.add("danger"); setTimeout(() => { armed = false; clearBtn.textContent = "Clear journal"; clearBtn.classList.remove("danger"); }, 4000); return; }
    onClear();
  } });
  out.push(h("div", { class: "jr-actions" },
    h("button", { class: "hx-btn ghost small", type: "button", text: "Download as a spreadsheet (CSV)", onclick: () => download(toCSV(res)) }),
    clearBtn,
    h("p", { class: "muted small", text: "Saved only in this browser on this device. Clearing your browser data deletes it. Results are estimates after typical charges, if all of the amount had been put into that plan." })));
  return out;
}

function download(text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = h("a", { href: url, download: "dalal-desk-journal.csv" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { /* not supported */ }
}
