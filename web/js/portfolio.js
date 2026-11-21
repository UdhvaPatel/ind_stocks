// "Desk portfolio": the Desk's own pretend-money results (data/portfolio.json). Paper money only.
import { lineChart } from "./charts.js";
import { clear, countUp, fmt, fmtDate, getJSON, h, reveal } from "./core.js";

const money = (x) => (x == null ? "-" : (x > 0 ? "+" : x < 0 ? "−" : "") + "₹" + Math.abs(Math.round(x)).toLocaleString("en-IN"));
const rs = (x) => "₹" + Math.round(x || 0).toLocaleString("en-IN");
const tone = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const RULE = { breakout: "Buy on a rise", pullback: "Buy on a dip", gap_reversal: "Buy a low opening" };
const STATUS = { not_triggered: "did not buy", cancelled: "cancelled", stopped: "stopped out", t1: "first target", t2: "both targets",
  time: "sold at 3:15 PM", void: "no session", pending: "waiting", unknown: "not recorded" };

// One sentence for the Home page banner (null before the portfolio has data).
export function portfolioHeadline(P) {
  if (!P || !P.books || !P.books.desk) return null;
  const t = P.books.desk.totals, need = P.min_days_for_verdict || 60;
  if (!t.sessions) return { text: `Dalal Desk paper portfolio: starts ${fmtDate(P.first_day, true)}. Every trading day it puts up to ₹1,00,000 of pretend money behind its own plans, and you can see the result here.`, tone: "" };
  return { text: `Dalal Desk paper portfolio (pretend money, not advice): ${t.sessions} verified session${t.sessions === 1 ? "" : "s"}, ${rs(t.deployed)} put to work across ${t.trades} trade${t.trades === 1 ? "" : "s"}, result after charges ${money(t.pnl)}. Doing nothing: ₹0.${t.sessions < need ? ` Too early to judge (needs ${need} sessions).` : ""}`, tone: tone(t.pnl) };
}

export async function renderPortfolio(root, ctx) {
  const { go } = ctx;
  const P = await getJSON("portfolio.json", { optional: true });
  clear(root);
  root.append(h("div", { class: "page-h" }, h("div", {},
    h("h1", { text: "Dalal Desk paper portfolio" }),
    h("p", { text: "Every trading day the Desk puts up to ₹1,00,000 of pretend money behind its own plans. The orders are written down before 9:15 AM and scored after the official close, with real charges. This is practice money: nothing here is a recommendation to trade." }))));
  if (!P) { root.append(h("div", { class: "card headline", text: "The portfolio has not been published yet. It appears after the next scheduled update." })); return; }
  const body = h("div", { class: "stack" });
  root.append(body);
  const desk = P.books.desk, t = desk.totals, need = P.min_days_for_verdict || 60;

  // ---- headline
  const big = h("div", { class: "pf-big " + tone(t.pnl) });
  countUp(big, t.pnl, money, 1100);
  body.append(h("section", { class: "hx-card pf-head" },
    h("span", { class: "hx-label", text: "As Dalal Desk, with pretend money" }),
    t.sessions
      ? [h("p", { class: "pf-line" }, "I put ", h("b", { text: rs(t.deployed) }), ` to work over ${t.sessions} verified session${t.sessions === 1 ? "" : "s"} and the result after charges is`), big,
         h("p", { class: "muted small", text: `${t.trades} trades, ${t.wins} with a gain. On ${t.idle_sessions} session${t.idle_sessions === 1 ? "" : "s"} it found nothing worth doing and kept the money (₹0).` })]
      : [h("p", { class: "pf-line", text: `The first verified session is ${fmtDate(P.first_day, true)}. Until then there is nothing real to show; below is what the same rules did on recent past days (a test replay).` })],
    t.sessions < need ? h("p", { class: "hx-early", text: `Only ${t.sessions} of ${need} verified sessions so far. Results over a few weeks are mostly luck; the page will say when there is enough to judge.` }) : null));

  // ---- comparisons
  const B = P.benchmarks || {};
  const hold = (B.nifty_hold && B.nifty_hold.days || []).slice(-1)[0];
  const tile = (label, value, note) => h("div", { class: "jr-tile" }, h("span", { text: label }), h("b", { class: tone(value), text: money(value) }), h("small", { text: note }));
  body.append(h("div", { class: "jr-tiles" },
    tile("DESK PORTFOLIO", t.pnl, `${t.sessions} verified sessions`),
    tile("DOING NOTHING", 0, "keeping the money"),
    tile("EVERY PLAN", B.every_plan ? B.every_plan.totals.pnl : null, "all plans, scaled to ₹1,00,000"),
    tile("NIFTY 50 DAY-TRADED", B.nifty_day ? B.nifty_day.pnl : null, hold ? `held instead: ${money(hold.value)}` : "bought at each open, sold at each close")));

  // ---- chart
  const cum = (days, key = "pnl") => { let c = 0; return days.map((d) => [d.date, Math.round((c += d[key] || 0))]); };
  const lines = [];
  const verified = desk.days.filter((d) => d.verified);
  if (verified.length >= 2) {
    lines.push({ name: "Desk portfolio", cls: "s3", points: cum(verified) });
    if (B.every_plan) lines.push({ name: "Every plan", cls: "s2", points: cum(B.every_plan.days.filter((d) => verified.some((v) => v.date === d.date))) });
    if (B.nifty_day) lines.push({ name: "Nifty 50 day-traded", cls: "s1", points: cum(B.nifty_day.days.filter((d) => verified.some((v) => v.date === d.date))) });
    lines.push({ name: "Doing nothing", cls: "base", points: verified.map((d) => [d.date, 0]) });
    const el = h("div", { class: "chart" });
    lineChart(el, lines, { unit: (v) => money(v) });
    body.append(h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "Running result after charges" }), h("span", { class: "hint", text: "verified sessions only" })),
      h("div", { class: "chart-wrap" }, el)));
  }

  // ---- daily positions
  if (desk.days.length) body.append(dayTable("Every session", desk.days, "Unverified sessions (shown faded) are not counted in the total."));

  // ---- practice book
  const pr = P.books.practice;
  if (pr) body.append(h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: pr.label }), h("span", { class: "hint", text: "not the Desk's call" })),
    h("div", { class: "card-b" }, h("p", { class: "muted small", text: pr.note }),
      pr.totals.sessions ? h("p", {}, `${pr.totals.sessions} verified sessions, ${pr.totals.trades} trades, result after charges `, h("b", { class: tone(pr.totals.pnl), text: money(pr.totals.pnl) }), ".")
        : h("p", { class: "muted", text: "Starts with the Desk portfolio." }))));

  body.append(allocatorCard(P.allocator, (P.books.allocator || {}).totals), replayCard(P.replay), rulesCard(P, go));
  reveal(body);
}

function dayTable(title, days, note) {
  const rows = days.slice().reverse();
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: title }), h("span", { class: "hint", text: note })),
    h("div", { class: "card-b scroll-x" }, h("table", { class: "tbl pf-tbl" },
      h("thead", {}, h("tr", {}, h("th", { text: "SESSION" }), h("th", { text: "WHAT IT DID" }), h("th", { class: "n", text: "PUT TO WORK" }), h("th", { class: "n", text: "RESULT" }))),
      h("tbody", {}, rows.map((d) => h("tr", { class: d.verified ? "" : "faded" },
        h("td", {}, fmtDate(d.date, true), d.verified ? null : h("span", { class: "pill", style: { marginLeft: "6px" }, text: "not proven" })),
        h("td", {}, d.positions.length ? d.positions.map((p) => h("div", { class: "pf-pos" },
          h("b", { text: p.symbol }), ` ${RULE[p.kind] || p.kind}, ${p.shares} shares: ${STATUS[p.status] || p.status}`,
          p.status in { stopped: 1, t1: 1, t2: 1, time: 1 } ? h("span", { class: tone(p.pnl), text: ` ${money(p.pnl)}` }) : null)) : h("span", { class: "muted", text: "Nothing worth doing: kept the money" })),
        h("td", { class: "n", text: d.deployed ? rs(d.deployed) : "-" }),
        h("td", { class: "n " + tone(d.pnl) }, h("b", { text: money(d.pnl) }))))))));
}

function allocatorCard(A, shadowTotals) {
  const card = h("section", { class: "card reveal" }, h("div", { class: "card-h" }, h("h3", { text: "The weekly learning model (shadow)" }), h("span", { class: "hint", text: "retrained every Sunday" })));
  if (!A || !A.walk_forward) {
    card.append(h("div", { class: "card-b" }, h("p", { class: "muted", text: "It trains for the first time at the next Sunday update. Until it has proved itself it only runs in the shadows: its choices are recorded and scored, but never become the Desk's portfolio." })));
    return card;
  }
  const w = A.walk_forward;
  card.append(h("div", { class: "card-b" },
    h("p", {}, "Each Sunday it learns, for every stock and plan, how likely the plan is to trigger and its expected result after costs, using only data from before that week. It takes a plan only when the expected value is clearly positive; otherwise it keeps cash."),
    h("dl", { class: "kv" },
      h("dt", { text: "Status" }), h("dd", { text: A.status }),
      h("dt", { text: "Tested on past weeks" }), h("dd", { text: w.sessions ? `${w.sessions} sessions, ${fmtDate(w.from)} to ${fmtDate(w.to)}` : "-" }),
      h("dt", { text: "Its result there (pretend ₹1,00,000 a day)" }), h("dd", { class: tone(w.total_pnl), text: money(w.total_pnl) }),
      h("dt", { text: "The simple Desk rules on the same days" }), h("dd", { class: tone(w.v1_total_pnl), text: money(w.v1_total_pnl) }),
      h("dt", { text: "Days it chose to trade" }), h("dd", { text: w.active_share != null ? fmt.prob(w.active_share) : "-" }),
      h("dt", { text: "Strength of evidence vs cash / vs Desk" }), h("dd", { text: `${w.t_vs_cash ?? "-"} / ${w.t_vs_v1 ?? "-"} (needs 2 or more)` }),
      h("dt", { text: "Live shadow sessions" }), h("dd", { text: `${A.shadow_sessions || 0} of ${A.shadow_needed || 60}` }),
      shadowTotals && shadowTotals.sessions ? h("dt", { text: "Its live shadow result" }) : null,
      shadowTotals && shadowTotals.sessions ? h("dd", { class: tone(shadowTotals.pnl), text: money(shadowTotals.pnl) }) : null),
    h("p", { class: "muted small", text: "It can only take over the Desk portfolio after passing the test on past weeks and 60 live shadow sessions, and only as a new, separately counted version." })));
  return card;
}

function replayCard(R) {
  if (!R || !R.days || !R.days.length) return null;
  const t = R.totals;
  const cum = (days) => { let c = 0; return days.map((d) => [d.date, Math.round((c += d.pnl || 0))]); };
  const el = h("div", { class: "chart" });
  lineChart(el, [{ name: "Desk rules (replay)", cls: "s3", points: cum(R.days) },
    { name: "Nifty 50 day-traded", cls: "s1", points: cum(R.nifty_day || []) }, { name: "Doing nothing", cls: "base", points: R.days.map((d) => [d.date, 0]) }], { unit: (v) => money(v) });
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "Test replay: the same rules on recent past days" }), h("span", { class: "pill amber", text: R.label })),
    h("div", { class: "card-b" }, h("p", {}, `${t.sessions} sessions: ${t.trades} trades, ${t.wins} with a gain, kept the money on ${t.idle_sessions}. Result after charges `, h("b", { class: tone(t.pnl), text: money(t.pnl) }), "."),
      h("p", { class: "muted small", text: R.note })),
    h("div", { class: "chart-wrap" }, el));
}

function rulesCard(P, go) {
  return h("section", { class: "card reveal" },
    h("div", { class: "card-h" }, h("h3", { text: "The rules, fixed in advance" })),
    h("div", { class: "card-b" }, h("ul", { class: "pf-rules" },
      h("li", { text: `At most ${rs(P.capital)} each session, reset every morning. Nothing is carried overnight or compounded.` }),
      h("li", { text: `Only plans the tool itself calls (Weak or Stronger signal), best measured record first, at most ${P.max_positions} stocks.` }),
      h("li", { text: `Each position risks at most ${rs(P.risk_per_trade)} if its stop is hit, and uses at most a quarter of the money.` }),
      h("li", { text: "Orders are written before 9:15 AM by the scheduled job and checked like the predictions; sessions that cannot be verified are not counted." }),
      h("li", { text: "Fills, exits and charges follow exactly the same rules as the rest of the site. Income tax is not included." }),
      h("li", { text: `Changing any rule starts a new version (now ${P.portfolio_version}); versions are never added together.` })),
      h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go("journal") }, "Keep your own paper journal", h("span", { class: "hx-arrow", text: "→" }))));
}
