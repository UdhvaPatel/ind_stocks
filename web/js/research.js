// The multi-day swing research (data/research.json), in plain words and as a table.
import { fmt, fmtDate, h } from "./core.js";

const pct = (x, d = 2) => (x == null ? "-" : fmt.pct(x, d));

// One sentence a newcomer can read.
export function researchHeadline(R) {
  if (!R || !R.variants) return null;
  const n = R.variants_tested, passed = (R.passed || []).length;
  return passed
    ? `We tested ${n} simple trading rules on 10 years of data; ${passed} looked promising in both test periods and is being watched, not yet trusted.`
    : `We tested ${n} simple trading rules on 10 years of data. After costs, none of them beat simply buying and holding the same stocks.`;
}

export function researchSection(R) {
  if (!R || !R.variants) return null;
  const rows = R.variants.slice().sort((a, b) => (a.test - b.test) || a.rule.localeCompare(b.rule) || a.hold_days - b.hold_days);
  const scale = Math.max(1, ...rows.map((v) => Math.abs(v.validation.excess_pct || 0)));
  const bar = (x) => h("div", { class: "rs-bar" }, h("span", { class: "rs-zero" }),
    h("i", { class: x >= 0 ? "pos" : "neg", style: { width: (Math.min(1, Math.abs(x || 0) / scale) * 50).toFixed(1) + "%" } }));
  return h("section", { class: "card reveal rs" },
    h("div", { class: "card-b" },
      h("h2", { text: "Is there a trading rule that beats the market? Our test" }),
      h("p", { text: researchHeadline(R) }),
      h("div", { class: "rs-facts" },
        h("div", {}, h("b", { text: String(R.variants_tested) }), h("span", { text: "rule variants tested" })),
        h("div", {}, h("b", { text: String((R.passed || []).length) }), h("span", { text: "passed both periods" })),
        h("div", {}, h("b", { text: `${R.typical_round_trip_cost_pct}%` }), h("span", { text: "cost of one buy-and-sell (delivery)" })),
        h("div", {}, h("b", { text: fmtDate(R.periods.validation[0]).slice(-4) + "–" + fmtDate(R.data_to).slice(-4) }), h("span", { text: "unseen test period" }))),
      h("details", { class: "more" }, h("summary", { text: "How the test was done" }),
        h("ul", {},
          h("li", { text: `Rules, holding periods and the pass rule were written down on ${fmtDate(R.preregistered)} before any result was seen. Test 2 (10 and 20-day holds) was added the same day after test 1 failed, and is reported separately.` }),
          h("li", { text: "Each signal buys at the next morning's open and sells at the close a fixed number of days later. No stops or targets, so nothing could be tuned." }),
          h("li", { text: "Every trade pays full delivery costs: securities tax on both sides, stamp duty, exchange fees, GST, the depository charge and slippage." }),
          h("li", { text: "Each trade is compared with holding the same 50 stocks over exactly the same days. Making money in a rising market is not an edge; beating it is." }),
          h("li", { text: `A rule passes only with ${R.pass_rule}, in 2017–2020 and again in ${fmtDate(R.periods.validation[0]).slice(-4)}–${fmtDate(R.data_to).slice(-4)}.` }),
          h("li", { text: "Caveat: the 50 stocks are today's Nifty 50, which flatters any buying rule a little. Even so, nothing passed." }))),
      h("div", { class: "scroll-x" }, h("table", { class: "tbl rs-tbl" },
        h("thead", {}, h("tr", {}, h("th", { text: "RULE" }), h("th", { class: "n", text: "HOLD" }), h("th", { class: "n", text: "TRADES" }),
          h("th", { class: "n", text: "BEFORE COSTS" }), h("th", { class: "n", text: "AFTER COSTS" }), h("th", { text: "VS HOLDING, 2021 ON" }),
          h("th", { class: "n", text: "2017–20" }), h("th", { text: "RESULT" }))),
        h("tbody", {}, rows.map((v) => {
          const w = v.validation, d = v.discovery;
          return h("tr", { title: v.how },
            h("td", {}, h("b", { text: v.label }), v.test === 2 ? h("small", { class: "muted", text: " · test 2" }) : null),
            h("td", { class: "n", text: `${v.hold_days} days` }),
            h("td", { class: "n", text: fmt.int(w.trades) }),
            h("td", { class: "n " + ((w.excess_before_costs_pct || 0) >= 0 ? "up" : "down"), text: pct(w.excess_before_costs_pct) }),
            h("td", { class: "n " + ((w.excess_pct || 0) >= 0 ? "up" : "down"), text: pct(w.excess_pct) }),
            h("td", {}, bar(w.excess_pct)),
            h("td", { class: "n " + ((d.excess_pct || 0) >= 0 ? "up" : "down"), text: pct(d.excess_pct) }),
            h("td", {}, h("span", { class: "pill " + (v.passed ? "good" : ""), text: v.passed ? "passed" : "no edge" })));
        })))),
      h("p", { class: "muted small", text: "Figures are the average per trade, compared with holding the same stocks over the same days. Below zero means holding did better. " + R.verdict })));
}
