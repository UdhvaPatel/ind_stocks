// Home: the simple path for a first-time visitor.
//   1. Choose a stock   2. See the plan for the next market day   3. See how past predictions did
import { clear, countUp, dir, fmt, fmtDate, getJSON, h, icon, prefs, reduced, s, symbolFile } from "./core.js";
import { AMOUNTS, lastSession, monogram, nextPlan, pastRows, record, RULE_TITLES } from "./homelogic.js";
import * as journal from "./journallogic.js";
import { researchHeadline } from "./research.js";

const px = (x) => "₹" + fmt.px(x);
const money = (x) => (x == null ? "-" : (x > 0 ? "+" : x < 0 ? "−" : "") + "₹" + Math.abs(Math.round(x)).toLocaleString("en-IN"));
const rs = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
const toneOf = (x) => (x == null || Math.round(x) === 0 ? "flat" : x > 0 ? "up" : "down");
const clock = (hhmm) => { const [hh, mm] = String(hhmm).split(":").map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "PM" : "AM"}`; };

export async function renderHome(root, ctx) {
  const { meta, market, params, go } = ctx;
  const [universe, compare, research] = await Promise.all([getJSON("universe.json", { optional: true }), getJSON("compare.json", { optional: true }),
    getJSON("research.json", { optional: true })]);
  const names = Object.fromEntries(((universe && universe.stocks) || []).map((x) => [x.symbol, x.name]));
  const stocks = market.heatmap.map((r) => ({ ...r, name: names[r.symbol] || r.symbol }));
  const symbols = stocks.map((x) => x.symbol);
  const state = {
    sym: [params.get("s"), prefs.get("home-sym", null), "RELIANCE", symbols[0]].find((x) => symbols.includes(x)),
    amount: prefs.get("home-amount", 50000), query: "", go,
  };

  clear(root);
  const page = h("div", { class: "hx" });
  root.append(page);
  page.append(hero(meta, compare));

  // ---- step 1: choose a stock
  const grid = h("div", { class: "hx-grid", role: "listbox", "aria-label": "Nifty 50 stocks" });
  const drawGrid = () => {
    clear(grid);
    const q = state.query.trim().toLowerCase();
    const list = stocks.filter((x) => !q || x.symbol.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
    if (!list.length) grid.append(h("p", { class: "hx-empty", text: "No stock matches that search." }));
    list.forEach((x, i) => grid.append(tile(x, i, x.symbol === state.sym, () => choose(x.symbol, true))));
  };
  page.append(h("section", { class: "hx-step", id: "hx-pick" },
    stepHead("1", "Choose a stock", "The 50 biggest companies on India's National Stock Exchange. Prices are the last official close."),
    h("div", { class: "hx-search" }, icon("search"),
      h("input", { type: "search", placeholder: "Search by name, e.g. Tata, Reliance, Infosys", "aria-label": "Search stocks",
        oninput: (e) => { state.query = e.target.value; drawGrid(); } })),
    grid));
  drawGrid();

  // ---- steps 2 and 3: the chosen stock
  const result = h("section", { class: "hx-result", id: "hx-result", "aria-live": "polite" });
  page.append(result);
  const headline = researchHeadline(research);
  page.append(h("section", { class: "hx-foot" },
    headline ? h("div", { class: "hx-research" }, h("span", { class: "hx-research-i", "aria-hidden": "true", text: "🔬" }),
      h("div", {}, h("b", { text: "Honest research" }), h("p", { text: headline + " That is why most days say “Wait”." })),
      h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go("how") }, "See the test", h("span", { class: "hx-arrow", text: "→" }))) : null,
    h("div", { class: "hx-foot-cards" },
      footCard("Plan with your own money", "Type an amount and a goal; see whether it is realistic for the next market day.", "Make a plan", () => go("plan")),
      footCard("See every prediction on a chart", "Predicted range against the real price, day by day, for any stock.", "Accuracy check", () => go("accuracy", { s: state.sym })),
      footCard("Detailed view for experienced users", "Candles, statistics, all three plans and their full records.", "Pro view", () => go("today", { s: state.sym }))),
    h("p", { class: "hx-legal", text: "Educational only, not investment advice. Predictions can be wrong, and past results do not guarantee future ones. Every money figure is an estimate after typical trading charges." })));

  let token = 0;
  const choose = async (sym, scroll) => {
    state.sym = sym;
    prefs.set("home-sym", sym);
    try { history.replaceState(null, "", `#/home?s=${encodeURIComponent(sym)}`); } catch (e) { /* not in a browser */ }
    grid.querySelectorAll(".hx-tile").forEach((t) => { const on = t.dataset.sym === sym; t.classList.toggle("on", on); t.setAttribute("aria-selected", on ? "true" : "false"); });
    const mine = ++token;
    clear(result).append(loadingCards());
    if (scroll && result.scrollIntoView) result.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
    let d;
    try { d = await getJSON(symbolFile(sym)); }
    catch (err) {
      if (mine !== token) return;
      clear(result).append(h("div", { class: "hx-card hx-error", role: "alert" }, h("b", { text: `${sym} could not be loaded.` }), h("p", { text: "Check your connection and try again." })));
      return;
    }
    if (mine !== token) return;                                 // a newer choice won
    const info = stocks.find((x) => x.symbol === sym);
    const draw = () => {
      clear(result).append(stockView(d, info, meta, compare, state, go, (a) => { state.amount = a; prefs.set("home-amount", a); draw(); }));
      tilt(result);
    };
    draw();
  };
  await choose(state.sym, false);
}

// ------------------------------------------------------------------ hero
function hero(meta, compare) {
  let accuracy = null;
  if (compare && compare.daily && compare.daily.length) {
    const last = compare.daily.slice(-20).filter((d) => Array.isArray(d) && typeof d[1] === "number");
    if (last.length) accuracy = last.reduce((a, d) => a + d[1], 0) / last.length;
  }
  const stat = (to, format, label) => { const v = h("b"); countUp(v, to, format, 1100); return h("div", { class: "hx-stat" }, v, h("span", { text: label })); };
  return h("section", { class: "hx-hero" },
    h("div", { class: "hx-orb", "aria-hidden": "true" }),
    h("div", { class: "hx-eyebrow" }, h("span", { class: "hx-live-dot" }), `Plans for ${fmtDate(meta.plan_for_date, true)}`),
    h("h1", { class: "hx-title" }, h("span", { text: "Know the plan " }), h("span", { class: "hx-shine", text: "before the market opens." })),
    h("p", { class: "hx-sub", text: "Pick a company. See what we expect for the next market day, the exact prices of a simple plan, and how often our past predictions were right, in rupees you can understand." }),
    h("ol", { class: "hx-steps" },
      [["1", "Choose a stock"], ["2", "See the next-day plan"], ["3", "Check our past record"]].map(([n, t], i) =>
        h("li", { style: { animationDelay: 350 + i * 120 + "ms" } }, h("i", { text: n }), t))),
    h("div", { class: "hx-stats" },
      stat(50, (v) => String(Math.round(v)), "big Indian companies"),
      accuracy != null ? stat(accuracy * 100, (v) => Math.round(v) + "%", "of closing prices landed in our range (last 20 days)") : null,
      stat(0, () => "Free", "no sign-up, no live tips")));
}

function stepHead(n, title, text) {
  return h("div", { class: "hx-step-h" }, h("span", { class: "hx-num", text: n }), h("div", {}, h("h2", { text: title }), h("p", { text })));
}

function tile(x, i, on, pick) {
  const t = h("button", { class: "hx-tile" + (on ? " on" : ""), type: "button", role: "option", "aria-selected": on ? "true" : "false",
    data: { sym: x.symbol }, style: { animationDelay: Math.min(i * 18, 700) + "ms" }, onclick: pick },
    h("span", { class: "hx-mono", vars: { "--hue": String(hue(x.symbol)) }, text: monogram(x.symbol, x.name) }),
    h("span", { class: "hx-tile-t" }, h("b", { text: x.symbol }), h("small", { text: shortName(x.name) })),
    h("span", { class: "hx-tile-p" }, h("b", { text: fmt.px(x.close) }), h("small", { class: dir(x.change_pct), text: fmt.pct(x.change_pct) })));
  return t;
}
const hue = (sym) => [...sym].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const shortName = (n) => String(n || "").replace(/\s+(Limited|Ltd\.?)$/i, "").replace(/\s+/g, " ");

function footCard(title, text, label, onclick) {
  return h("div", { class: "hx-foot-card" }, h("b", { text: title }), h("p", { text }), h("button", { class: "hx-btn ghost", type: "button", onclick }, label, h("span", { class: "hx-arrow", text: "→" })));
}

// --------------------------------------------------------- loading state
function loadingCards() {
  const bar = (w) => h("div", { class: "hx-sk", style: { width: w } });
  return h("div", { class: "hx-loading", role: "status", "aria-label": "Loading the plan" },
    h("div", { class: "hx-loader" }, h("div", { class: "hx-ring" }), h("div", { class: "hx-candles" }, h("i"), h("i"), h("i"), h("i")), h("span", { text: "Reading the latest plan…" })),
    h("div", { class: "hx-cards" }, [0, 1, 2].map(() => h("div", { class: "hx-card hx-sk-card" }, bar("40%"), bar("85%"), bar("70%"), h("div", { class: "hx-sk tall" }), bar("60%")))));
}

// ------------------------------------------------------------ stock view
function stockView(d, info, meta, compare, state, go, setAmount) {
  const plan = nextPlan(d, state.amount, meta.costs);
  const rows = pastRows(compare, d.symbol);
  const last = lastSession(rows, state.amount);
  const rec = record(rows, state.amount, 20);
  const amountBar = h("div", { class: "hx-amount" },
    h("span", { class: "hx-amount-l", text: "If I put in" }),
    h("div", { class: "hx-amount-chips" }, AMOUNTS.map((a) => h("button", { class: "hx-chip" + (state.amount === a ? " on" : ""), type: "button", text: "₹" + a.toLocaleString("en-IN"), onclick: () => setAmount(a) }))),
    h("label", { class: "hx-amount-in" }, h("span", { text: "₹" }),
      h("input", { type: "number", min: 1000, step: 1000, value: state.amount, "aria-label": "Amount in rupees",
        onchange: (e) => { const v = Math.round(Number(e.target.value)); if (v >= 100 && v <= 1e8) setAmount(v); else e.target.value = state.amount; } })));
  const head = h("div", { class: "hx-stock" },
    h("span", { class: "hx-mono big", vars: { "--hue": String(hue(d.symbol)) }, text: monogram(d.symbol, info && info.name) }),
    h("div", { class: "hx-stock-t" }, h("h2", { text: shortName((info && info.name) || d.name || d.symbol) }),
      h("span", { text: `NSE: ${d.symbol}${d.industry ? " · " + d.industry : ""}` })),
    h("div", { class: "hx-stock-p" }, (() => { const v = h("b"); countUp(v, d.last.close, (x) => px(x), 700); return v; })(),
      h("span", { class: dir(d.last.change_pct), text: `${fmt.pct(d.last.change_pct)} on ${fmtDate(d.as_of)}` })),
    h("button", { class: "hx-btn ghost small", type: "button", onclick: () => { const el = document.getElementById("hx-pick"); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }); } }, "Change stock"));
  return h("div", { class: "hx-result-in" },
    head, amountBar,
    h("div", { class: "hx-cards" },
      planCard(plan, d, meta, state),
      yesterdayCard(last, state),
      recordCard(rec, rows, state, d.symbol, go)));
}

// -------------------------------------------------- card 2: the next day
function planCard(p, d, meta, state) {
  const card = h("article", { class: "hx-card" });
  card.append(h("div", { class: "hx-card-h" }, h("span", { class: "hx-num sm", text: "2" }), h("div", {}, h("h3", { text: "Plan for the next market day" }), h("span", { text: fmtDate(d.for_date || meta.plan_for_date, true) }))));
  if (!p) { card.append(h("p", { class: "hx-muted", text: "No plan could be made for this stock today." })); return card; }
  const v = p.verdict;
  card.append(
    h("div", { class: "hx-verdict " + v.tone }, h("span", { class: "hx-badge " + v.tone }, h("i"), v.badge), h("b", { text: v.title }), h("p", { text: v.text })),
    h("div", { class: "hx-expect" },
      h("div", {}, h("span", { text: "Expected closing price" }), h("b", { text: p.rangeLo ? `${px(p.rangeLo)} – ${px(p.rangeHi)}` : "-" }), h("small", { text: "on 9 out of 10 similar days" })),
      h("div", {}, h("span", { text: "Chance it closes higher" }), h("b", { text: p.pUp == null ? "-" : fmt.prob(p.pUp) }),
        h("div", { class: "hx-meter" }, h("i", { style: { width: Math.round((p.pUp || 0) * 100) + "%" } }), h("em", { "aria-hidden": "true" })),
        h("small", { text: p.pUp == null ? "" : p.pUp > 0.55 ? "leans up" : p.pUp < 0.45 ? "leans down" : "close to a coin flip" }))),
    h("div", { class: "hx-plan" },
      h("div", { class: "hx-plan-h" }, h("b", { text: `The plan: ${p.ruleTitle.toLowerCase()}` }), h("span", { text: p.pTrigger == null ? "" : `triggers on about ${fmt.prob(p.pTrigger)} of days` })),
      h("ol", { class: "hx-timeline" },
        p.gap
          ? [tl("buy", "9:15 AM", `Buy only if it opens at ${px(p.entry)} or lower${p.floor ? ` (not below ${px(p.floor)})` : ""}.`),
             tl("profit", "During the day", `Sell when it gets back to ${px(p.t1)}.`),
             tl("stop", "If it keeps falling", `Sell about ${px(p.entry - p.stop)} below your buy price to limit the loss.`),
             tl("end", clock(p.exitBy), "Sell anything still held. Nothing is kept overnight.")]
          : [tl("buy", `Until ${clock(p.cancelAfter)}`, `Buy only if the price ${p.kind === "breakout" ? "rises to" : "dips to"} ${px(p.entry)}. Otherwise do nothing.`),
             tl("profit", "Take profit", `Sell half at ${px(p.t1)} and the rest at ${px(p.t2)}.`),
             tl("stop", "Limit the loss", `Sell everything if it falls to ${px(p.stop)}.`),
             tl("end", clock(p.exitBy), "Sell anything still held. Nothing is kept overnight.")])),
    p.shares
      ? h("div", { class: "hx-money" },
          h("p", { text: `With ${rs(state.amount)} you could buy ${p.shares.toLocaleString("en-IN")} share${p.shares === 1 ? "" : "s"} (${rs(p.invested)}).` }),
          h("div", { class: "hx-money-row" },
            moneyBox("If it goes well", p.best, "up"), moneyBox("If it goes badly", p.worst, "down")),
          h("small", { class: "hx-muted", text: "After charges. Most days the price never reaches the buy level, so nothing happens and nothing is lost." }))
      : h("div", { class: "hx-money" }, h("p", { text: `${rs(state.amount)} is not enough for one share at the buy price of ${px(p.entry)}.` })),
    p.shares ? followButton({ symbol: d.symbol, forDate: d.for_date || meta.plan_for_date, kind: p.kind, amount: state.amount,
      entry: p.entry, stop: p.stop, t1: p.t1, t2: p.t2, call: p.call }, state.go) : null);
  return card;
}

// Paper trading: remember that the visitor would follow this plan (this browser only).
function followButton(entry, go) {
  const box = h("div", { class: "hx-follow-btn" });
  const draw = () => {
    const inJournal = journal.has(journal.load(), entry);
    clear(box).append(inJournal
      ? h("div", { class: "hx-followed" }, h("span", { class: "hx-tick" }, icon("check")),
          h("div", {}, h("b", { text: "In your paper-trading journal" }), h("p", { text: `With ${rs(entry.amount)}. The result appears after the market closes on ${fmtDate(entry.forDate)}.` })),
          h("div", { class: "hx-followed-act" },
            h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go && go("journal") }, "Open journal"),
            h("button", { class: "linkish", type: "button", text: "Undo", onclick: () => { journal.save(journal.remove(journal.load(), journal.entryId(entry))); draw(); } })))
      : h("button", { class: "hx-btn hx-follow-go", type: "button", onclick: () => { journal.save(journal.add(journal.load(), entry)); draw(); } },
          "I'd follow this plan", h("small", { text: "practise with pretend money" })));
  };
  draw();
  return box;
}
const tl = (cls, when, text) => h("li", { class: cls }, h("span", { text: when }), h("p", { text }));
function moneyBox(label, value, cls) {
  const b = h("b", { class: cls });
  countUp(b, value, money, 900);
  return h("div", { class: "hx-money-box " + cls }, h("span", { text: label }), b);
}

// ---------------------------------------------------- card 3a: yesterday
function yesterdayCard(L, state) {
  const card = h("article", { class: "hx-card" });
  card.append(h("div", { class: "hx-card-h" }, h("span", { class: "hx-num sm", text: "3" }),
    h("div", {}, h("h3", { text: "If you had followed it last time" }), h("span", { text: L ? fmtDate(L.date, true) : "" })),
    L ? h("span", { class: "hx-tag " + (L.track === "live" ? "live" : "replay"), title: L.track === "live" ? "Written down before that market opened." : "Re-run afterwards by the same code using only earlier data.", text: L.track === "live" ? "Real prediction" : "Test replay" }) : null));
  if (!L) { card.append(h("p", { class: "hx-muted", text: "No past predictions have been scored for this stock yet." })); return card; }
  card.append(
    L.wait && L.wait.verdict !== "unknown" ? waitBox(L.wait, state) : followBox(L, state),
    h("div", { class: "hx-checks" },
      check(L.inside, "Price prediction", `We said ${px(L.lo)} – ${px(L.hi)}. It closed at ${px(L.close)}.`),
      L.right == null ? null : check(L.right, "Up or down", `We gave a ${fmt.prob(L.pUp)} chance of rising. It ${L.ret > 0 ? "rose" : L.ret < 0 ? "fell" : "was flat"} ${fmt.pct(L.ret)}.`)),
    h("div", { class: "hx-others" }, h("span", { class: "hx-label", text: "What each plan would have done" }),
      L.others.map((o) => h("div", { class: "hx-other" + (o.shown ? " shown" : "") },
        h("span", {}, o.title, o.shown ? h("em", { text: "shown" }) : null),
        h("b", { class: o.known ? toneOf(o.money) : "flat", text: !o.known ? "not recorded yet" : o.traded ? money(o.money) : "no trade, ₹0" })))));
  return card;
}
// The advice was a plan to follow: show what following it made.
function followBox(L, state) {
  const big = h("div", { class: "hx-big " + toneOf(L.followed) });
  countUp(big, L.followed == null ? 0 : L.followed, (x) => (L.followed == null ? "-" : money(x)), 1000);
  return h("div", { class: "hx-result-box " + toneOf(L.followed) },
    h("span", { text: `With ${rs(state.amount)}, following “${(RULE_TITLES[L.kind] || "the plan").toLowerCase()}”` }), big,
    h("p", { text: L.traded === false ? `${L.story} You would still have all ${rs(state.amount)}.` : L.story }));
}

// The advice was "wait": say whether waiting was right, against what the plans would have done.
function waitBox(W, state) {
  const tone = { saved: "up", missed: "miss", mixed: "flat", nothing: "flat" }[W.verdict];
  const value = W.verdict === "saved" ? -W.worst.money : W.verdict === "missed" ? W.best.money : 0;
  const label = { saved: (x) => `${rs(x)} saved`, missed: (x) => `${rs(x)} missed`, mixed: () => "Mixed day", nothing: () => "₹0, nothing happened" }[W.verdict];
  const big = h("div", { class: "hx-big " + tone });
  countUp(big, value, label, 1000);
  const t = (x) => x.title.toLowerCase();
  const text = {
    saved: () => `Waiting was right. Buying anyway (“${t(W.worst)}”) would have lost ${rs(-W.worst.money)} of your ${rs(state.amount)}.`,
    missed: () => `Waiting missed out this time. “${W.best.title}” would have made ${rs(W.best.money)}. One day proves little; the record on the right shows how often waiting paid off.`,
    mixed: () => `“${W.best.title}” would have made ${rs(W.best.money)}, but “${t(W.worst)}” would have lost ${rs(-W.worst.money)}. Waiting kept you out of both.`,
    nothing: () => "None of the plans would have bought anything, so waiting cost nothing.",
  }[W.verdict]() + (W.partial ? " (Some plans' results are not recorded yet.)" : "");
  return h("div", { class: "hx-result-box " + tone },
    h("span", {}, "Our advice was ", h("b", { class: "hx-advice", text: "Wait" }), `. With ${rs(state.amount)}:`), big, h("p", { text }));
}

function check(ok, title, text) {
  return h("div", { class: "hx-check " + (ok ? "ok" : "no") }, h("span", { class: "hx-tick" }, icon(ok ? "check" : "cross")),
    h("div", {}, h("b", { text: `${title}: ${ok ? "correct" : "missed"}` }), h("p", { text })));
}

// ---------------------------------------------------- card 3b: the record
function recordCard(R, rows, state, sym, go) {
  const card = h("article", { class: "hx-card" });
  card.append(h("div", { class: "hx-card-h" }, h("span", { class: "hx-num sm", text: "✓" }),
    h("div", {}, h("h3", { text: "How often we were right" }), h("span", { text: R ? `last ${R.n} market days` : "" }))));
  if (!R) { card.append(h("p", { class: "hx-muted", text: "Not enough history yet." })); return card; }
  card.append(
    h("div", { class: "hx-rings" },
      ring(R.inside, R.n, "closing price landed in our range", "Our aim is 9 out of 10."),
      ring(R.right, R.dirN, "up-or-down call was right", "A coin flip gets about half.")),
    h("div", { class: "hx-dots", role: "list", "aria-label": "Each day: price prediction correct or missed" },
      R.days.map((x, i) => h("span", { class: "hx-dot " + (x.inside ? "ok" : "no") + (x.track === "live" ? " live" : ""), role: "listitem", title: `${fmtDate(x.date)}: ${x.inside ? "inside our range" : "outside our range"}`, style: { animationDelay: 200 + i * 35 + "ms" } }))),
    h("div", { class: "hx-dots-key" }, h("span", { text: `${fmtDate(R.days[0].date)}` }), h("span", { text: "green = correct, red = missed" }), h("span", { text: fmtDate(R.days[R.days.length - 1].date) })));
  const total = h("b", { class: toneOf(R.total) });
  countUp(total, R.total, money, 1000);
  const W = R.waits;
  if (W && W.days && W.days > W.unknown) {
    const seg = (n, cls, label) => (n ? h("i", { class: cls, style: { flexGrow: String(n) }, title: `${n} ${label}` }) : null);
    card.append(h("div", { class: "hx-waits" },
      h("span", { class: "hx-label", text: `When we said “wait” (${W.days} of ${R.n} days)` }),
      h("div", { class: "hx-waitbar", role: "img", "aria-label": `Waiting avoided a loss on ${W.saved} days, missed a gain on ${W.missed}, mixed on ${W.mixed}, nothing happened on ${W.nothing}` },
        seg(W.saved, "s", "days waiting avoided a loss"), seg(W.mixed, "x", "mixed days"), seg(W.nothing, "n", "days nothing happened"), seg(W.missed, "m", "days waiting missed a gain")),
      h("div", { class: "hx-waitkey" },
        h("span", { class: "s" }, h("i"), `avoided a loss: ${W.saved}`), h("span", { class: "m" }, h("i"), `missed a gain: ${W.missed}`),
        W.mixed ? h("span", { class: "x" }, h("i"), `mixed: ${W.mixed}`) : null, h("span", { class: "n" }, h("i"), `nothing happened: ${W.nothing}`)),
      h("p", { text: `Losses avoided add up to ${rs(W.avoided)}; gains missed add up to ${rs(W.forgone)} (worst and best plan each day, ${rs(state.amount)} each time).${W.unknown ? ` ${W.unknown} day${W.unknown === 1 ? "" : "s"} not recorded yet.` : ""}` })));
  }
  card.append(h("div", { class: "hx-follow" },
    h("span", { class: "hx-label", text: `Following the shown plan every day, ${rs(state.amount)} each time` }), total,
    h("p", { text: R.trades ? `${R.trades} trade${R.trades === 1 ? "" : "s"} in ${R.planDays} days, ${R.wins} with a gain. On the other days the plan never bought anything.` : `The plan did not buy on any of these ${R.planDays} days, so nothing was gained or lost.` })),
    h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go("accuracy", { s: sym }) }, "See every day on a chart", h("span", { class: "hx-arrow", text: "→" })));
  return card;
}
function ring(k, n, label, note) {
  const r = 30, c = 2 * Math.PI * r, frac = n ? k / n : 0;
  const arc = s("circle", { class: "arc", cx: 36, cy: 36, r, "stroke-dasharray": c.toFixed(2), "stroke-dashoffset": c.toFixed(2) });
  const svg = s("svg", { viewBox: "0 0 72 72", "aria-hidden": "true" }, s("circle", { class: "trk", cx: 36, cy: 36, r }), arc);
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute("stroke-dashoffset", (c * (1 - frac)).toFixed(2))));
  return h("div", { class: "hx-ring-box" }, h("div", { class: "hx-ring-g" }, svg, h("b", { text: `${k}/${n}` })), h("div", {}, h("span", { text: label }), h("small", { text: note })));
}

// ------------------------------------------------------------- 3D tilt
function tilt(scope) {
  if (reduced() || !scope.querySelectorAll) return;
  scope.querySelectorAll(".hx-card").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--rx", (-y * 4).toFixed(2) + "deg");
      el.style.setProperty("--ry", (x * 5).toFixed(2) + "deg");
      el.style.setProperty("--mx", (x + 0.5) * 100 + "%");
      el.style.setProperty("--my", (y + 0.5) * 100 + "%");
    });
    el.addEventListener("pointerleave", () => { el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); });
  });
}
