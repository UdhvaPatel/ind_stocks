// Help for newcomers (welcome card, "words explained" panel), loading placeholders,
// and the small pointer effects shared by every page.
import { clear, h, prefs, reduced } from "./core.js";

export const STEPS = [
  { n: "1", title: "Pick a company", text: "Choose any of the 50 big Indian companies from the list on the left, or tap a tile in the coloured grid." },
  { n: "2", title: "Read the verdict", text: "“No trade” means the tool found no tested reason to act. That is the honest answer on most days." },
  { n: "3", title: "Try your own numbers", text: "On “Make a plan”, type an amount and a goal. The site tells you whether that goal is realistic." },
  { n: "4", title: "Practise for free", text: "Press “I'd follow this plan” on Home; “My journal” shows how it would have gone, with pretend money." },
];

export const GLOSSARY = [
  ["Nifty 50", "The 50 largest companies on India's National Stock Exchange. This site covers only these."],
  ["Close", "The last official price of the day. Everything here is based on closing prices; nothing is live."],
  ["Plan", "A set of prices written down before the market opens: where to buy, where to give up, where to take profit."],
  ["Entry", "The price at which the plan would buy. If the price never gets there, nothing happens."],
  ["Stop", "The give-up price. If the price falls to it, the plan sells and accepts a small, known loss."],
  ["Target", "The take-profit price. If the price rises to it, the plan sells and keeps the gain."],
  ["Trigger", "The moment the price reaches the entry. Many plans never trigger."],
  ["No trade", "The tool's most common verdict: no rule has earned money on this stock after costs, so do nothing."],
  ["After costs", "After brokerage, taxes and the small price slip you get on real orders. Small gains often vanish here."],
  ["R", "The amount risked on one trade. “+0.5 R” means the gain was half of what was put at risk; “−1 R” is a full loss."],
  ["Win rate", "Out of 100 past trades, how many ended with a gain. A high win rate can still lose money if the losses are bigger."],
  ["ATR", "Average True Range: how far the price usually moves in one day. A calm stock has a small ATR."],
  ["90% range", "A band the closing price fell inside on 9 of 10 similar past days. One day in 10 it falls outside."],
  ["Backtest", "A replay of the rules over past years. Useful, but easier than real life; “Live” results count for more."],
  ["IST", "India Standard Time. Every clock and date on this site is in IST, wherever you are."],
];

// ------------------------------------------------------------ welcome card
export function welcomeCard(go) {
  if (prefs.get("welcome-seen", false)) return null;
  const card = h("section", { class: "card welcome", "aria-label": "Getting started" },
    h("div", { class: "welcome-top" },
      h("div", {},
        h("div", { class: "eyebrow", text: "New here? Start with this" }),
        h("h2", { text: "This site helps you learn how one trading day works. It does not tell you what to buy." }),
        h("p", { text: "Each morning it writes down simple what-if price levels for 50 big Indian companies, and each evening it checks itself against what really happened. There are no live prices and no tips." })),
      h("button", { class: "btn welcome-x", type: "button", "aria-label": "Hide this introduction", text: "Got it", onclick: () => {
        prefs.set("welcome-seen", true);
        card.classList.add("leaving");
        setTimeout(() => card.remove(), reduced() ? 0 : 320);
      } })),
    h("ol", { class: "welcome-steps" }, STEPS.map((s, i) => h("li", { style: { animationDelay: 120 + i * 90 + "ms" } },
      h("span", { class: "ws-n", text: s.n }), h("div", {}, h("b", { text: s.title }), h("p", { text: s.text }))))),
    h("div", { class: "welcome-act" },
      h("button", { class: "btn primary", type: "button", text: "Try “Make a plan”", onclick: () => go("plan") }),
      h("button", { class: "btn", type: "button", text: "Words explained", onclick: () => openHelp(go) }),
      h("span", { class: "muted small", text: "Green means a price rose, red means it fell, saffron marks the tool's own levels." })));
  return card;
}

// --------------------------------------------------------------- help panel
let helpEl = null, lastFocus = null;
export function closeHelp() {
  if (!helpEl) return;
  helpEl.remove(); helpEl = null;
  document.removeEventListener("keydown", onKey);
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function onKey(e) { if (e.key === "Escape") closeHelp(); }
export function openHelp(go) {
  if (helpEl) return;
  lastFocus = document.activeElement;
  const list = h("dl", { class: "gloss" });
  const draw = (q) => {
    clear(list);
    const rows = GLOSSARY.filter(([w, t]) => !q || (w + " " + t).toLowerCase().includes(q.toLowerCase()));
    if (!rows.length) list.append(h("p", { class: "muted", text: "No matching word. Try a shorter search." }));
    rows.forEach(([w, t], i) => list.append(h("div", { class: "gloss-row", style: { animationDelay: Math.min(i * 25, 300) + "ms" } }, h("dt", { text: w }), h("dd", { text: t }))));
  };
  draw("");
  const close = h("button", { class: "btn", type: "button", text: "Close", onclick: closeHelp });
  helpEl = h("div", { class: "help-back", onclick: (e) => { if (e.target === helpEl) closeHelp(); } },
    h("div", { class: "help", role: "dialog", "aria-modal": "true", "aria-label": "Help: how to use this site" },
      h("div", { class: "help-h" }, h("h2", { text: "How to use this site" }), close),
      h("div", { class: "help-b" },
        h("ol", { class: "welcome-steps compact" }, STEPS.map((s) => h("li", {}, h("span", { class: "ws-n", text: s.n }), h("div", {}, h("b", { text: s.title }), h("p", { text: s.text }))))),
        h("div", { class: "help-key" },
          h("span", {}, h("i", { class: "sw", style: { background: "var(--up)" } }), "price rose"),
          h("span", {}, h("i", { class: "sw", style: { background: "var(--down)" } }), "price fell"),
          h("span", {}, h("i", { class: "sw", style: { background: "var(--accent)" } }), "the tool's own levels")),
        h("h3", { text: "Words explained" }),
        h("input", { class: "help-search", type: "search", placeholder: "Search a word, e.g. stop", "aria-label": "Search the glossary", oninput: (e) => draw(e.target.value) }),
        list,
        h("div", { class: "welcome-act" },
          h("button", { class: "btn", type: "button", text: "Read the full method", onclick: () => { closeHelp(); go("how"); } }),
          h("button", { class: "btn", type: "button", text: "Show the welcome card again", onclick: () => { prefs.set("welcome-seen", false); closeHelp(); go("today"); } })))));
  document.body.append(helpEl);
  document.addEventListener("keydown", onKey);
  close.focus();
}

// One-line plain explanations shown above the pages that have no welcome card.
export const SIMPLE = {
  track: "In simple words: this page marks the tool's own homework. It shows how often its forecasts were right, next to how often a plain guess would have been right. If the two are close, the tool is not adding much, and the page says so.",
  archive: "In simple words: pick any past day to see what the tool said that morning and what the market actually did that evening.",
};
export function simpleNote(route, go) {
  if (!SIMPLE[route]) return null;
  return h("div", { class: "simple" }, h("span", { class: "simple-i", "aria-hidden": "true", text: "i" }), h("p", { text: SIMPLE[route] }),
    h("button", { class: "linkish", type: "button", text: "Words explained", onclick: () => openHelp(go) }));
}

// ------------------------------------------------------ loading placeholders
export function skeleton(route) {
  const bar = (w, hgt) => h("div", { class: "sk", style: { width: w, height: hgt || "12px" } });
  const block = (lines, tall) => h("div", { class: "card sk-card" }, bar("38%", "11px"), tall ? h("div", { class: "sk sk-tall" }) : null,
    Array.from({ length: lines }, (_, i) => bar(`${92 - i * 13}%`)));
  const loader = h("div", { class: "sk-loader", role: "status" }, h("span", { class: "bars", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")),
    h("span", { text: { home: "Preparing your market view…", journal: "Opening your journal…", accuracy: "Lining up predictions and real prices…", today: "Reading the latest prices…", plan: "Getting the plan levels…", track: "Adding up the scoreboard…", archive: "Opening the archive…", how: "Loading…" }[route] || "Loading…" }));
  if (route === "today") {
    return h("div", { class: "sk-wrap" }, loader, h("div", { class: "desk" },
      h("div", { class: "col" }, block(7)), h("div", { class: "col" }, block(2), block(3, true), block(4)), h("div", { class: "col" }, block(6), block(3))));
  }
  return h("div", { class: "sk-wrap" }, loader, h("div", { class: "stack" }, block(3), block(4, true), block(3)));
}

// ------------------------------------------------------------ pointer effects
// One listener for the whole page: a soft light that follows the pointer across cards,
// and a ripple on buttons. Both are skipped when reduced motion is requested.
export function pointerEffects() {
  if (reduced()) return;
  let raf = 0, evt = null;
  document.addEventListener("pointermove", (e) => {
    evt = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const el = evt.target && evt.target.closest ? evt.target.closest(".card, .pcard, .alt, .fact, .idx") : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", evt.clientX - r.left + "px");
      el.style.setProperty("--my", evt.clientY - r.top + "px");
    });
  }, { passive: true });
  document.addEventListener("pointerdown", (e) => {
    const el = e.target && e.target.closest ? e.target.closest(".btn, .chip, .tab, .seg button, .nav a, .icon-btn, .help-fab") : null;
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2;
    const dot = h("span", { class: "ripple", style: { width: size + "px", height: size + "px", left: e.clientX - r.left - size / 2 + "px", top: e.clientY - r.top - size / 2 + "px" } });
    el.classList.add("rippling");
    el.append(dot);
    setTimeout(() => { dot.remove(); el.classList.remove("rippling"); }, 620);
  }, { passive: true });
}
