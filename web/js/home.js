// Home: the simple path for a first-time visitor.
//   1. Choose a stock   2. See the picture for the next market day   3. See how past predictions did
// Wording rule: the site never tells anyone to buy. On "Wait" days the practice plan is folded away
// and always described in the third person ("the plan would buy if...").
import { clear, countUp, dir, fmt, fmtDate, getJSON, h, icon, prefs, reduced, s, symbolFile } from "./core.js";
import { getLang, setLang, t } from "./i18n.js";
import { AMOUNTS, lastSession, monogram, nextPlan, pastRows, record, RULE_TITLES } from "./homelogic.js";
import * as journal from "./journallogic.js";
import { portfolioHeadline } from "./portfolio.js";
import { researchHeadline } from "./research.js";
import { marketSeries } from "./comparelogic.js";

const POPULAR = ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "ITC", "BHARTIARTL"];
const px = (x) => "₹" + fmt.px(x);
const money = (x) => (x == null ? "-" : (x > 0 ? "+" : x < 0 ? "−" : "") + "₹" + Math.abs(Math.round(x)).toLocaleString("en-IN"));
const rs = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
const toneOf = (x) => (x == null || Math.round(x) === 0 ? "flat" : x > 0 ? "up" : "down");
const clock = (hhmm) => { const [hh, mm] = String(hhmm).split(":").map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "PM" : "AM"}`; };
const TRACK = { live: ["Real prediction", "live", "Written by the scheduled job before that market opened."],
  unverified: ["Not proven", "unverified", "Made outside the scheduled job, so its timing cannot be checked."],
  backtest: ["Test replay", "replay", "Re-run afterwards by the same code using only earlier data."] };

export async function renderHome(root, ctx) {
  const { meta, market, params, go } = ctx;
  const [universe, index, research, portfolio] = await Promise.all([
    getJSON("universe.json", { optional: true }), getJSON("compare/index.json", { optional: true }), getJSON("research.json", { optional: true }),
    getJSON("portfolio.json", { optional: true })]);
  const names = Object.fromEntries(((universe && universe.stocks) || []).map((x) => [x.symbol, x.name]));
  const stocks = market.heatmap.map((r) => ({ ...r, name: names[r.symbol] || r.symbol }));
  const symbols = stocks.map((x) => x.symbol);
  // No stock is chosen for the visitor: a pre-picked stock next to a date reads like a tip.
  const state = {
    sym: [params.get("s"), prefs.get("home-sym", null)].find((x) => symbols.includes(x)) || null,
    amount: prefs.get("home-amount", 10000), query: "", showAll: false, go,
  };

  clear(root);
  const page = h("div", { class: "hx" });
  root.append(page);
  page.append(hero(meta, index));
  const banner = portfolioHeadline(portfolio);
  if (banner) page.append(h("button", { class: "hx-pf-banner " + banner.tone, type: "button", onclick: () => go("portfolio") },
    h("span", { class: "hx-pf-i", "aria-hidden": "true", text: "📊" }), h("span", { text: banner.text }), h("span", { class: "hx-arrow", text: "→" })));

  // ---- step 1: choose a stock
  const grid = h("div", { class: "hx-grid", "aria-label": "Nifty 50 stocks" });
  const more = h("button", { class: "hx-btn ghost small hx-more", type: "button", onclick: () => { state.showAll = !state.showAll; drawGrid(); } });
  const drawGrid = () => {
    clear(grid);
    const q = state.query.trim().toLowerCase();
    const list = stocks.filter((x) => !q || x.symbol.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
    grid.classList.toggle("open", state.showAll || !!q);
    more.textContent = state.showAll ? t("Show fewer") : t("Show all 50 companies");
    if (!list.length) grid.append(h("p", { class: "hx-empty", text: t("No stock matches that search.") }));
    list.forEach((x, i) => grid.append(tile(x, i, x.symbol === state.sym, () => choose(x.symbol, true))));
  };
  const popular = h("div", { class: "hx-popular" }, h("span", { text: t("Popular:") }),
    POPULAR.filter((p) => symbols.includes(p)).map((p) => h("button", { class: "hx-chip", type: "button", text: p, onclick: () => choose(p, true) })));
  page.append(h("section", { class: "hx-step", id: "hx-pick" },
    stepHead("1", t("Choose a stock"), t("The 50 biggest companies on India's National Stock Exchange. Prices are the last official close; nothing here is live.")),
    h("div", { class: "hx-search" }, icon("search"),
      h("input", { type: "search", placeholder: t("Search by name, e.g. Tata, Reliance, Infosys"), "aria-label": "Search stocks",
        oninput: (e) => { state.query = e.target.value; drawGrid(); } })),
    popular, grid, more));
  drawGrid();

  // ---- steps 2 and 3
  const live = h("p", { class: "sr-only", "aria-live": "polite" });          // one short line for screen readers
  const result = h("section", { class: "hx-result", id: "hx-result" });
  page.append(live, result);
  const headline = researchHeadline(research);
  page.append(h("section", { class: "hx-foot" },
    headline ? h("div", { class: "hx-research" }, h("span", { class: "hx-research-i", "aria-hidden": "true", text: "🔬" }),
      h("div", {}, h("b", { text: t("Honest research") }), h("p", { text: headline + " That is why most days say “Wait”." })),
      h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go("how") }, t("See the test"), h("span", { class: "hx-arrow", text: "→" }))) : null,
    h("div", { class: "hx-foot-cards" },
      footCard(t("Plan with your own money"), "Type an amount and a goal; see whether it is realistic for the next market day.", t("Make a plan"), () => go("plan")),
      footCard(t("See every prediction on a chart"), "Predicted range against the real price, day by day, for any stock.", t("Accuracy"), () => go("accuracy", state.sym ? { s: state.sym } : {})),
      footCard(t("Detailed view for experienced users"), "Candles, statistics, all three plans and their full records.", t("Pro view"), () => go("today", state.sym ? { s: state.sym } : {}))),
    h("p", { class: "hx-legal", text: t("Educational only, not investment advice. Predictions can be wrong, and past results do not guarantee future ones. Every money figure is an estimate after typical trading charges.") })));

  let token = 0;
  const choose = async (sym, scroll) => {
    state.sym = sym;
    prefs.set("home-sym", sym);
    try { history.replaceState(null, "", `#/home?s=${encodeURIComponent(sym)}`); } catch (e) { /* not in a browser */ }
    grid.querySelectorAll(".hx-tile").forEach((x) => { const on = x.dataset.sym === sym; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on ? "true" : "false"); });
    const mine = ++token;
    clear(result).append(loadingCards());
    if (scroll && result.scrollIntoView) result.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
    let d, hist, histFailed = false;
    try {
      [d, hist] = await Promise.all([getJSON(symbolFile(sym)), getJSON(`compare/${sym.replace(/[^A-Za-z0-9_-]/g, "_")}.json`, { optional: true })]);
      if (!hist) { hist = await getJSON("compare.json", { optional: true }); histFailed = !hist; }
    } catch (err) {
      if (mine !== token) return;
      clear(result).append(h("div", { class: "hx-card hx-error", role: "alert" }, h("b", { text: `${sym} could not be loaded.` }),
        h("p", { text: "Check your connection and try again." }), h("button", { class: "hx-btn", type: "button", text: t("Try again"), onclick: () => choose(sym, false) })));
      return;
    }
    if (mine !== token) return;                                              // a newer choice won
    const info = stocks.find((x) => x.symbol === sym);
    const draw = () => {
      clear(result).append(stockView(d, info, meta, hist, histFailed, index, state, go, (a) => { state.amount = a; prefs.set("home-amount", a); draw(); }));
      tilt(result);
      const p = nextPlan(d, state.amount, meta.costs);
      live.textContent = p ? `${sym}: ${t(p.verdict.badge)}. ${p.rangeLo ? `Likely closing range ${px(p.rangeLo)} to ${px(p.rangeHi)}.` : ""}` : `${sym} loaded.`;
    };
    draw();
  };
  if (state.sym) await choose(state.sym, false);
  else result.append(h("div", { class: "hx-prompt" }, h("span", { "aria-hidden": "true", text: "👆" }), h("p", { text: t("Pick any company above to see how the tool would have handled it.") })));
}

// ------------------------------------------------------------------ hero
function hero(meta, index) {
  const recent = marketSeries(index, "20");
  const avg = (key) => { const v = recent.map((d) => d[key]).filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const coverage = avg("coverage"), openHit = avg("dirHitOpen");
  const stat = (to, format, label) => { const v = h("b"); countUp(v, to, format, 1100); return h("div", { class: "hx-stat" }, v, h("span", { text: label })); };
  const toggle = h("button", { class: "hx-lang", type: "button", "aria-label": "Switch language / भाषा बदलें", text: getLang() === "hi" ? "English" : "हिंदी",
    onclick: () => { setLang(getLang() === "hi" ? "en" : "hi"); location.reload(); } });
  return h("section", { class: "hx-hero" },
    h("div", { class: "hx-orb", "aria-hidden": "true" }),
    h("div", { class: "hx-hero-top" }, h("div", { class: "hx-eyebrow" }, h("span", { class: "hx-dot-static" }), t("Plans for {date}", { date: fmtDate(meta.plan_for_date, true) })), toggle),
    h("h1", { class: "hx-title" }, h("span", { text: t("Know the plan") + " " }), h("span", { class: "hx-shine", text: t("before the market opens.") })),
    h("p", { class: "hx-sub", text: t("Pick a company. See what we expect for the next market day, the exact prices of a simple practice plan, and how often our past predictions were right, in rupees you can understand.") }),
    h("ol", { class: "hx-steps" },
      [["1", t("Choose a stock")], ["2", t("See the next-day picture")], ["3", t("Check our past record")]].map(([n, x], i) =>
        h("li", { style: { animationDelay: 350 + i * 120 + "ms" } }, h("i", { text: n }), x))),
    h("div", { class: "hx-stats" },
      coverage != null ? stat(coverage * 100, (v) => Math.round(v) + "%", t("closing prices landed inside our range (aim 90%; the range is wide)")) : null,
      openHit != null ? stat(openHit * 100, (v) => Math.round(v) + "%", t("up/down calls right from the opening price (a coin flip gets 50%)")) : null,
      stat(50, (v) => String(Math.round(v)), t("big Indian companies"))));
}

function stepHead(n, title, text) {
  return h("div", { class: "hx-step-h" }, h("span", { class: "hx-num", text: n }), h("div", {}, h("h2", { text: title }), h("p", { text })));
}

function tile(x, i, on, pick) {
  return h("button", { class: "hx-tile" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false",
    "aria-label": `${x.symbol}, ${shortName(x.name)}, ${fmt.px(x.close)} rupees, ${fmt.pct(x.change_pct)}`,
    data: { sym: x.symbol }, vars: { "--hue": String(hue(x.symbol)) }, style: { animationDelay: Math.min(i * 18, 700) + "ms" }, onclick: pick },
    h("span", { class: "hx-mono", text: monogram(x.symbol, x.name) }),
    h("span", { class: "hx-tile-t" }, h("b", { text: x.symbol }), h("small", { text: shortName(x.name) })),
    h("span", { class: "hx-tile-p" }, h("b", { text: fmt.px(x.close) }), h("small", { class: dir(x.change_pct), text: fmt.pct(x.change_pct) })));
}
const hue = (sym) => [...sym].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const shortName = (n) => String(n || "").replace(/\s+(Limited|Ltd\.?)$/i, "").replace(/\s+/g, " ");

function footCard(title, text, label, onclick) {
  return h("div", { class: "hx-foot-card" }, h("b", { text: title }), h("p", { text }), h("button", { class: "hx-btn ghost", type: "button", onclick }, label, h("span", { class: "hx-arrow", text: "→" })));
}

// --------------------------------------------------------- loading state
function loadingCards() {
  const bar = (w) => h("div", { class: "hx-sk", style: { width: w } });
  return h("div", { class: "hx-loading", role: "status", "aria-label": "Loading" },
    h("div", { class: "hx-loader" }, h("div", { class: "hx-ring" }), h("div", { class: "hx-candles" }, h("i"), h("i"), h("i"), h("i")), h("span", { text: "Reading the latest figures…" })),
    h("div", { class: "hx-cards" }, [0, 1, 2].map(() => h("div", { class: "hx-card hx-sk-card" }, bar("40%"), bar("85%"), bar("70%"), h("div", { class: "hx-sk tall" }), bar("60%")))));
}

// ------------------------------------------------------------ stock view
function stockView(d, info, meta, hist, histFailed, index, state, go, setAmount) {
  const plan = nextPlan(d, state.amount, meta.costs);
  const rows = pastRows(hist, d.symbol);
  const last = lastSession(rows, state.amount);
  const rec = record(rows, state.amount, 20);
  const liveDays = index && index.track ? index.track.filter((x) => x === "live").length : 0;
  const amountBar = h("div", { class: "hx-amount" },
    h("span", { class: "hx-amount-l", text: t("If I put in") }),
    h("div", { class: "hx-amount-chips", role: "group", "aria-label": "Amount" }, AMOUNTS.map((a) => h("button", { class: "hx-chip" + (state.amount === a ? " on" : ""), type: "button", "aria-pressed": state.amount === a ? "true" : "false", text: rs(a), onclick: () => setAmount(a) }))),
    h("label", { class: "hx-amount-in" }, h("span", { text: "₹" }),
      h("input", { type: "number", min: 1000, step: 1000, value: state.amount, "aria-label": "Amount in rupees",
        onchange: (e) => { const v = Math.round(Number(e.target.value)); if (v >= 100 && v <= 1e8) setAmount(v); else e.target.value = state.amount; } })));
  const head = h("div", { class: "hx-stock" },
    h("span", { class: "hx-mono big", vars: { "--hue": String(hue(d.symbol)) }, text: monogram(d.symbol, info && info.name) }),
    h("div", { class: "hx-stock-t" }, h("h2", { text: shortName((info && info.name) || d.name || d.symbol) }),
      h("span", { text: `NSE: ${d.symbol}${d.industry ? " · " + d.industry : ""}` })),
    h("div", { class: "hx-stock-p" }, (() => { const v = h("b"); countUp(v, d.last.close, (x) => px(x), 700); return v; })(),
      h("span", { class: dir(d.last.change_pct), text: `${fmt.pct(d.last.change_pct)} ${t("on {date}", { date: fmtDate(d.as_of) })}` })),
    h("button", { class: "hx-btn ghost small", type: "button", onclick: () => { const el = document.getElementById("hx-pick"); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }); } }, t("Change stock")));
  return h("div", { class: "hx-result-in" },
    head, verdictStrip(plan, d, meta), amountBar,
    h("div", { class: "hx-cards" },
      yesterdayCard(last, state, histFailed),
      recordCard(rec, state, d.symbol, go, liveDays, histFailed),
      planCard(plan, d, meta, state)));
}

// The answer first: one strip with the verdict and the two forecast numbers.
function verdictStrip(p, d, meta) {
  if (!p) return h("div", { class: "hx-card hx-strip" }, h("p", { class: "hx-muted", text: "No forecast could be made for this stock today (not enough comparable history)." }));
  const v = p.verdict;
  return h("section", { class: "hx-strip " + v.tone },
    h("div", { class: "hx-strip-v" },
      h("span", { class: "hx-label", text: `${t("Next market day")} · ${fmtDate(d.for_date || meta.plan_for_date, true)}` }),
      h("span", { class: "hx-badge " + v.tone }, h("i"), t(v.badge)),
      v.tone === "wait" ? h("b", { text: t(v.title) }) : null,
      h("p", { text: t(v.text) })),
    h("div", { class: "hx-strip-n" },
      h("div", {}, h("span", { text: t("Likely closing range") }), h("b", { text: p.rangeLo ? `${px(p.rangeLo)} – ${px(p.rangeHi)}` : "-" }), h("small", { text: t("on 9 out of 10 similar days") })),
      h("div", {}, h("span", { text: t("Chance of a higher close") }), h("b", { text: p.pUp == null ? "-" : fmt.prob(p.pUp) }),
        h("div", { class: "hx-meter" }, h("i", { style: { width: Math.round((p.pUp || 0) * 100) + "%" } }), h("em", { "aria-hidden": "true" })),
        h("small", { text: t("a coin flip is 50%") }))));
}

// ----------------------------------------------- card: the practice plan
function planCard(p, d, meta, state) {
  const card = h("article", { class: "hx-card hx-plan-card" });
  if (!p) { card.append(h("p", { class: "hx-muted", text: "No practice plan could be made for this stock today." })); return card; }
  const steps = h("ol", { class: "hx-timeline" },
    p.gap
      ? [tl("buy", "9:15 AM", `The plan would buy only if the stock opens at ${px(p.entry)} or lower${p.floor ? ` (but not below ${px(p.floor)})` : ""}.`),
         tl("profit", "During the day", `It would sell when the price gets back to ${px(p.t1)}.`),
         tl("stop", "If it keeps falling", `It would sell about ${px(p.entry - p.stop)} below its buy price, to limit the loss.`),
         tl("end", clock(p.exitBy), "It would sell anything still held. Nothing is kept overnight.")]
      : [tl("buy", `Until ${clock(p.cancelAfter)}`, `The plan would buy only if the price ${p.kind === "breakout" ? "rises to" : "dips to"} ${px(p.entry)}. Otherwise it does nothing.`),
         tl("profit", "Profit levels", `It would sell half at ${px(p.t1)} and the rest at ${px(p.t2)}.`),
         tl("stop", "Loss limit", `It would sell everything if the price falls to ${px(p.stop)}.`),
         tl("end", clock(p.exitBy), "It would sell anything still held. Nothing is kept overnight.")]);
  const quiet = p.pTrigger == null ? "" : `Most days (about ${Math.round((1 - p.pTrigger) * 10)} in 10) this plan never buys, so nothing happens: ₹0. `;
  const moneyBlock = p.shares
    ? h("div", { class: "hx-money" },
        h("p", { text: `${quiet}With ${rs(state.amount)} it could buy ${p.shares.toLocaleString("en-IN")} share${p.shares === 1 ? "" : "s"} (${rs(p.invested)}). If it does buy:` }),
        h("div", { class: "hx-money-row" }, moneyBox("If it goes badly", p.worst, "down"), moneyBox("If it goes well", p.best, "up")),
        h("small", { class: "hx-muted", text: "After charges and typical slippage, the same way the scoreboard counts them." }))
    : h("div", { class: "hx-money" }, h("p", { text: `${rs(state.amount)} is not enough for one share at the plan's buy price of ${px(p.entry)}.` }));
  const follow = p.shares ? followButton({ symbol: d.symbol, forDate: d.for_date || meta.plan_for_date, kind: p.kind, amount: state.amount,
    entry: p.entry, stop: p.stop, t1: p.t1, t2: p.t2, call: p.call }, state.go) : null;
  const inner = [
    h("div", { class: "hx-plan-h" }, h("b", { text: t("Practice plan: {name}", { name: p.ruleTitle.toLowerCase() }) }),
      h("span", { text: p.pTrigger == null ? "" : t("It triggers on about {p} of days", { p: fmt.prob(p.pTrigger) }) })),
    steps, moneyBlock, follow];
  if (p.call === "NO_TRADE") {
    card.append(h("details", { class: "hx-fold" },
      h("summary", {}, h("span", { class: "hx-num sm", text: "2" }), h("div", {}, h("h3", { text: t("See the practice plan (for learning only)") }),
        h("span", { text: "Shown to learn how a plan works, not as a suggestion to trade." }))),
      h("div", { class: "hx-fold-b" }, ...inner)));
  } else {
    card.append(h("div", { class: "hx-card-h" }, h("span", { class: "hx-num sm", text: "2" }),
      h("div", {}, h("h3", { text: t("Practice plan: {name}", { name: p.ruleTitle.toLowerCase() }) }), h("span", { text: "Described as a what-if; it can lose money." }))), ...inner.slice(1));
  }
  return card;
}
const tl = (cls, when, text) => h("li", { class: cls }, h("span", { text: when }), h("p", { text }));
function moneyBox(label, value, cls) {
  const b = h("b", { class: cls });
  countUp(b, value, money, 900);
  return h("div", { class: "hx-money-box " + cls }, h("span", { text: label }), b);
}

// Paper trading: remember that the visitor would follow this plan (this browser only).
function followButton(entry, go) {
  const box = h("div", { class: "hx-follow-btn" });
  const draw = () => {
    const inJournal = journal.has(journal.load(), entry);
    clear(box).append(inJournal
      ? h("div", { class: "hx-followed" }, h("span", { class: "hx-tick" }, icon("check")),
          h("div", {}, h("b", { text: t("In your paper-trading journal") }), h("p", { text: `With ${rs(entry.amount)} of pretend money. The result appears after the market closes on ${fmtDate(entry.forDate)}.` })),
          h("div", { class: "hx-followed-act" },
            h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go && go("journal") }, t("Open journal")),
            h("button", { class: "hx-btn ghost small", type: "button", text: t("Undo"), onclick: () => { journal.save(journal.remove(journal.load(), journal.entryId(entry))); draw(); } })))
      : h("button", { class: "hx-btn ghost hx-follow-go", type: "button", onclick: () => { journal.save(journal.add(journal.load(), entry)); draw(); } },
          t("Practise with pretend money"), h("small", { text: "adds this plan to your journal; no real money" })));
  };
  draw();
  return box;
}

// ------------------------------------------------------- card: last time
function yesterdayCard(L, state, histFailed) {
  const card = h("article", { class: "hx-card" });
  const [label, cls, why] = L ? TRACK[L.track] || TRACK.backtest : [];
  card.append(h("div", { class: "hx-card-h" }, h("span", { class: "hx-num sm", text: "3" }),
    h("div", {}, h("h3", { text: t("Last time") }), h("span", { text: L ? fmtDate(L.date, true) : "" })),
    L ? h("span", { class: "hx-tag " + cls, title: why, text: t(label) }) : null));
  if (!L) { card.append(h("p", { class: "hx-muted", text: histFailed ? "The history could not be loaded. Check your connection and reload." : "No past predictions have been scored for this stock yet." })); return card; }
  card.append(
    L.wait && L.wait.verdict !== "unknown" ? waitBox(L.wait, state) : followBox(L, state),
    h("div", { class: "hx-checks" },
      check(L.inside, t("Price prediction"), `We said ${px(L.lo)} – ${px(L.hi)}. It closed at ${px(L.close)}.`),
      L.right == null ? null : check(L.right, t("Up or down"), `We gave a ${fmt.prob(L.pUp)} chance of a higher close. It ${L.ret > 0 ? "rose" : L.ret < 0 ? "fell" : "was flat"} ${fmt.pct(L.ret)}.`)),
    h("details", { class: "hx-others" }, h("summary", { class: "hx-label", text: "What each of the three plans did" }),
      L.others.map((o) => h("div", { class: "hx-other" + (o.shown ? " shown" : "") },
        h("span", {}, o.title, o.shown ? h("em", { text: "shown" }) : null),
        h("b", { class: o.known ? toneOf(o.money) : "flat", text: !o.known ? "not recorded yet" : o.traded ? money(o.money) : "did not buy, ₹0" })))));
  return card;
}

function followBox(L, state) {
  const big = h("div", { class: "hx-big " + toneOf(L.followed) });
  countUp(big, L.followed == null ? 0 : L.followed, (x) => (L.followed == null ? "-" : money(x)), 1000);
  return h("div", { class: "hx-result-box " + toneOf(L.followed) },
    h("span", { text: `With ${rs(state.amount)}, the plan shown that morning (“${(RULE_TITLES[L.kind] || "plan").toLowerCase()}”):` }), big,
    h("p", { text: L.traded === false ? `${L.story} All ${rs(state.amount)} would be unchanged.` : L.story }));
}

// The advice was "wait": what did the one practice plan shown that morning do? (No hindsight picks.)
function waitBox(W, state) {
  const tone = { saved: "up", missed: "miss", nothing: "flat" }[W.verdict];
  const amt = Math.abs(W.plan.money || 0);
  const big = h("div", { class: "hx-big " + tone });
  countUp(big, amt, (x) => (W.verdict === "nothing" ? "₹0" : rs(x)), 1000);
  const name = W.plan.title.toLowerCase();
  const text = {
    saved: `The practice plan (“${name}”) bought and lost ${rs(amt)} of your ${rs(state.amount)}. Waiting avoided that loss.`,
    missed: `The practice plan (“${name}”) bought and made ${rs(amt)}. Waiting missed that gain. One day proves little; see the record next to this.`,
    nothing: `The practice plan (“${name}”) never bought anything, so waiting and following it came to the same: ₹0.`,
  }[W.verdict];
  return h("div", { class: "hx-result-box " + tone },
    h("span", {}, "Our advice was ", h("b", { class: "hx-advice", text: t("Wait") }), `. With ${rs(state.amount)}:`), big, h("p", { text }));
}

function check(ok, title, text) {
  return h("div", { class: "hx-check " + (ok ? "ok" : "no") }, h("span", { class: "hx-tick" }, icon(ok ? "check" : "cross")),
    h("div", {}, h("b", { text: `${title}: ${ok ? t("correct") : t("missed")}` }), h("p", { text })));
}

// ------------------------------------------------------ card: the record
function recordCard(R, state, sym, go, liveDays, histFailed) {
  const card = h("article", { class: "hx-card" });
  card.append(h("div", { class: "hx-card-h" }, h("span", { class: "hx-num sm", text: "✓" }),
    h("div", {}, h("h3", { text: t("How often we were right") }), h("span", { text: R ? t("last {n} market days", { n: R.n }) : "" }))));
  if (!R) { card.append(h("p", { class: "hx-muted", text: histFailed ? "The history could not be loaded." : "Not enough history yet." })); return card; }
  if (liveDays < 30) card.append(h("p", { class: "hx-early", text: t("Only {n} verified live day{s} so far. Too early to judge; treat these figures as a test replay.", { n: liveDays, s: liveDays === 1 ? "" : "s" }) }));
  card.append(
    h("div", { class: "hx-rings" },
      ring(R.inside, R.n, t("closing price landed in our range"), t("Our aim is 9 out of 10.")),
      ring(R.right, R.dirN, t("up-or-down call was right"), t("A coin flip gets about half."))),
    h("div", { class: "hx-dots", role: "list", "aria-label": "Each day: price prediction correct or missed" },
      R.days.map((x, i) => h("span", { class: "hx-dot " + (x.inside ? "ok" : "no") + (x.track === "live" ? " live" : ""), role: "listitem",
        "aria-label": `${fmtDate(x.date)}: ${x.inside ? "inside our range" : "outside our range"}`, title: `${fmtDate(x.date)}: ${x.inside ? "inside our range" : "outside our range"}`,
        style: { animationDelay: 200 + i * 35 + "ms" }, text: x.inside ? "✓" : "✗" }))),
    h("div", { class: "hx-dots-key" }, h("span", { text: fmtDate(R.days[0].date) }), h("span", { text: "✓ inside the range · ✗ outside" }), h("span", { text: fmtDate(R.days[R.days.length - 1].date) })));
  const W = R.waits;
  if (W && W.days && W.days > W.unknown) {
    const seg = (n, cls, label) => (n ? h("i", { class: cls, style: { flexGrow: String(n) }, title: `${n} ${label}` }) : null);
    card.append(h("div", { class: "hx-waits" },
      h("span", { class: "hx-label", text: `When we said “wait” (${W.days} of ${R.n} days), the practice plan shown that morning:` }),
      h("div", { class: "hx-waitbar", role: "img", "aria-label": `Lost money on ${W.saved} days, made money on ${W.missed}, did not buy on ${W.nothing}` },
        seg(W.saved, "s", "days it lost"), seg(W.nothing, "n", "days it did not buy"), seg(W.missed, "m", "days it made money")),
      h("div", { class: "hx-waitkey" },
        h("span", { class: "s" }, h("i"), `lost: ${W.saved}`), h("span", { class: "m" }, h("i"), `made money: ${W.missed}`), h("span", { class: "n" }, h("i"), `did not buy: ${W.nothing}`)),
      h("p", { text: `Losses it would have made: ${rs(W.avoided)}. Gains it would have made: ${rs(W.forgone)}. (${rs(state.amount)} each time.)${W.unknown ? ` ${W.unknown} day${W.unknown === 1 ? "" : "s"} not recorded yet.` : ""}` })));
  }
  card.append(h("button", { class: "hx-btn ghost small", type: "button", onclick: () => go("accuracy", { s: sym }) }, t("See every day on a chart"), h("span", { class: "hx-arrow", text: "→" })));
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
  if (reduced() || !scope.querySelectorAll || (typeof matchMedia === "function" && matchMedia("(hover: none)").matches)) return;
  scope.querySelectorAll(".hx-card").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--rx", (-y * 3).toFixed(2) + "deg");
      el.style.setProperty("--ry", (x * 4).toFixed(2) + "deg");
      el.style.setProperty("--mx", (x + 0.5) * 100 + "%");
      el.style.setProperty("--my", (y + 0.5) * 100 + "%");
    });
    el.addEventListener("pointerleave", () => { el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg"); });
  });
}
