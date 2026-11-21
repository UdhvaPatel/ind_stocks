// Dalal Desk - app shell: clock (always India time), index strip, ticker, mode banner, router.
import { arrow, clear, countUp, dir, fmt, fmtDate, fmtStampIST, getJSON, h, istNow, prefs, reduced, s, SCHEMA } from "./js/core.js";
import { renderAccuracy } from "./js/accuracy.js";
import { renderArchive } from "./js/archive.js";
import { openHelp, pointerEffects, simpleNote, skeleton, welcomeCard } from "./js/guide.js";
import { renderHow } from "./js/how.js";
import { renderPlan } from "./js/plan.js";
import { renderToday } from "./js/today.js";
import { renderTrack } from "./js/track.js";

const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;
const view = document.getElementById("view");
const routes = { today: renderToday, plan: renderPlan, accuracy: renderAccuracy, track: renderTrack, archive: renderArchive, how: renderHow };
let ctx = null;

// ------------------------------------------------------------------- intro
function intro() {
  const el = document.getElementById("intro");
  let seen = false;
  try { seen = sessionStorage.getItem("dd-intro") === "1"; sessionStorage.setItem("dd-intro", "1"); } catch (e) { /* ignore */ }
  if (seen || reduced()) { el.classList.add("done"); return; }
  const svg = el.querySelector(".intro-candles");
  const closes = [52, 58, 50, 61, 66, 59, 70, 64, 74, 80, 73, 84, 90, 86, 98];
  // faint grid, then candles growing left to right, then a trend line drawn through the closes
  for (const y of [30, 60, 90]) svg.append(s("line", { class: "igrid", x1: 0, x2: 320, y1: y, y2: y }));
  const pts = [];
  closes.slice(1).forEach((c, i) => {
    const o = closes[i], up = c >= o, x = 14 + i * 21, top = 118 - Math.max(o, c), bot = 118 - Math.min(o, c);
    const delay = `animation-delay:${i * 45}ms`;
    pts.push(`${x},${118 - c}`);
    svg.append(s("line", { class: "wick " + (up ? "up" : "dn"), x1: x, x2: x, y1: top - 7, y2: bot + 7, style: delay }),
               s("rect", { class: "body " + (up ? "up" : "dn"), x: x - 5.5, width: 11, y: top, height: Math.max(3, bot - top), rx: 1.5, style: delay }));
  });
  const [lx, ly] = pts[pts.length - 1].split(",");
  svg.append(s("polyline", { class: "itrend", points: pts.join(" "), pathLength: 1 }),
             s("circle", { class: "iping", cx: lx, cy: ly, r: 9 }), s("circle", { class: "idot", cx: lx, cy: ly, r: 3.5 }));
  el.classList.add("play");
  const finish = () => { el.classList.add("done"); removeEventListener("keydown", finish); };
  el.addEventListener("click", finish);
  addEventListener("keydown", finish);
  setTimeout(finish, 3100);
}

// ------------------------------------------------------------------- theme
function theme() {
  document.getElementById("themeBtn").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.getAttribute("data-theme") ? root.getAttribute("data-theme") === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("dd-theme", next); } catch (e) { /* ignore */ }
  });
}

// ------------------------------------------------------------------- clock
function sessionState(now, meta) {
  const isSession = meta.plan_for_date === now.date || meta.last_eod_date === now.date;
  if (!isSession) return { key: "closed", label: "Market closed today", frac: 0 };
  if (now.minutes < 9 * 60) return { key: "pre", label: "Before the open", frac: 0 };
  if (now.minutes < OPEN) return { key: "pre", label: "Pre-open session", frac: 0 };
  if (now.minutes < CLOSE) return { key: "open", label: "Market open", frac: (now.minutes - OPEN + now.s / 60) / (CLOSE - OPEN) };
  return { key: "closed", label: "Market closed", frac: 1 };
}
function startClock(meta) {
  const time = document.getElementById("clockTime"), dot = document.getElementById("clockDot"), state = document.getElementById("clockState");
  let lastKey = null, lastDate = null;
  const tick = () => {
    const now = istNow(), st = sessionState(now, meta);
    time.textContent = now.clock;
    state.textContent = st.label;
    dot.className = "clock-dot " + st.key;
    const fill = document.querySelector(".session-fill");
    if (fill) fill.style.transform = `scaleX(${st.frac.toFixed(4)})`;
    if (st.key !== lastKey || now.date !== lastDate) { lastKey = st.key; lastDate = now.date; banner(meta); }
  };
  tick();
  setInterval(tick, 1000);
}

// ------------------------------------------------------------ strip + tape
function strip(market) {
  const el = clear(document.getElementById("strip"));
  const order = ["NIFTY50", "SENSEX", "BANKNIFTY", "INDIAVIX"];
  for (const key of order) {
    const x = market.indices.find((i) => i.key === key);
    if (!x) continue;
    const val = h("span", { class: "idx-val" });
    countUp(val, x.close, fmt.px, 900);
    el.append(h("div", { class: "idx", title: `Official close of ${fmtDate(x.date)}` },
      h("span", { class: "idx-name", text: x.label }),
      val,
      h("span", { class: "idx-chg " + dir(x.change_pct) }, `${arrow(x.change_pct)} `, h("span", { class: "idx-pts", text: `${fmt.signed(x.change, 2)} ` }), `(${fmt.pct(x.change_pct)})`)));
  }
}
function tape(market, go) {
  const track = clear(document.getElementById("tapeTrack"));
  const make = () => market.heatmap.map((r) => h("span", { class: "tape-item", onclick: () => go("today", { s: r.symbol }) },
    h("b", { text: r.symbol }), h("span", { class: "px", text: fmt.px(r.close) }),
    h("span", { class: dir(r.change_pct), text: `${arrow(r.change_pct)} ${fmt.pct(r.change_pct)}` })));
  track.append(...make(), ...make());                 // doubled so the loop is seamless
}

// ------------------------------------------------------------------ banner
function banner(meta) {
  const el = clear(document.getElementById("banner"));
  const now = istNow(), today = now.date, st = sessionState(now, meta);
  let mode, title, text;
  const plan = fmtDate(meta.plan_for_date, true);
  const status = { scored: "Committed to the ledger before the open.", draft: "Draft: the scored plan is committed at about 06:00 IST.",
                   not_issued: "No plan was issued for this session." }[meta.plan_status] || "";
  if (meta.plan_for_date === today) {
    mode = "plan";
    if (now.minutes < OPEN) { title = `Plan for today, ${plan}`; text = status; }
    else if (now.minutes < CLOSE) { title = "Market open"; text = `Showing this morning's plan for ${plan}. There are no live prices on this site; the result arrives after about 18:00 IST.`; }
    else { title = "Market closed"; text = "Waiting for the official NSE end-of-day file, usually published after 18:00 IST. Today's result appears here once it is processed."; }
  } else if (meta.last_eod_date === today) {
    mode = "result"; title = `Today's result is in (${fmtDate(today)})`; text = `Official prices are processed and today's plan is scored. A draft plan for ${plan} is shown; it is committed at about 06:00 IST.`;
  } else if (meta.plan_for_date > today) {
    mode = "closed"; title = "Markets are closed today"; text = `Last official session: ${fmtDate(meta.last_eod_date, true)}. Next session: ${plan}. ${status}`;
  } else {
    mode = "stale"; title = "This data is out of date"; text = `The last plan was for ${plan}. The scheduled update has not run; the page shows the last good data.`;
  }
  const label = { plan: "PLAN", result: "RESULT", closed: "CLOSED", stale: "STALE" }[mode];
  el.append(h("div", { class: "banner-card" },
    h("span", { class: "mode " + mode }, h("i"), label),
    h("div", { class: "banner-text" }, h("b", { text: title + ". " }), h("span", { text: text }),
      h("div", { class: "banner-sub", text: `Updated ${fmtStampIST(meta.generated_at)} · all times are India Standard Time` })),
    h("div", { class: "session", title: "NSE trading session, 09:15 to 15:30 IST" },
      h("div", { class: "session-bar" }, h("div", { class: "session-fill", style: { transform: `scaleX(${st.frac.toFixed(4)})` } })),
      h("div", { class: "session-ticks" }, h("span", { text: "09:15" }), h("span", { text: "14:30" }), h("span", { text: "15:30" })))));
  const ageH = (Date.now() - new Date(meta.generated_at).getTime()) / 36e5;
  const warn = meta.pipeline_status && meta.pipeline_status !== "ok" ? meta.message
    : mode !== "stale" && ageH > 40 && meta.plan_for_date <= today ? "The last update is more than a day old. Figures may be stale." : null;
  if (warn) el.append(h("div", { class: "banner-warn", text: warn }));
}

// ------------------------------------------------------------------ router
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  return { route: routes[path] ? path : "today", params: new URLSearchParams(query || "") };
}
function go(route, params = {}) {
  const q = new URLSearchParams(params).toString();
  const next = `#/${route}${q ? "?" + q : ""}`;
  if (location.hash === next) render(); else location.hash = next;
}
let renderToken = 0, shownRoute = null;
async function render() {
  const { route, params } = parseHash();
  const token = ++renderToken;                               // the last navigation wins
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === route));
  view.style.opacity = "0.55";
  progress(true);
  // Placeholders appear only if the page takes a moment, so quick loads do not flicker.
  const wait = setTimeout(() => { if (token === renderToken && route !== shownRoute) { clear(view).append(skeleton(route)); view.style.opacity = "1"; } }, 220);
  try {
    const holder = document.createElement("div");
    await routes[route](holder, { ...ctx, params, go });
    if (token !== renderToken) return;
    const first = route === "today" ? welcomeCard(go) : simpleNote(route, go);
    clear(view).append(...[first, ...holder.childNodes].filter(Boolean));
    view.querySelectorAll(".reveal").forEach((el, i) => { el.style.transitionDelay = Math.min(i * 40, 320) + "ms"; el.classList.add("in"); });
    if (route !== shownRoute) { view.classList.remove("enter"); void view.offsetWidth; view.classList.add("enter"); }
    if (route !== shownRoute || route !== "today" || !params.get("s")) scrollTo({ top: 0 });
    shownRoute = route;
  } catch (err) {
    if (token !== renderToken) return;
    clear(view).append(h("div", { class: "card headline" }, h("b", { text: "This page could not be loaded. " }), String(err.message || err)));
  } finally {
    clearTimeout(wait);
    if (token === renderToken) { view.style.opacity = "1"; progress(false); }
  }
}

// Thin bar under the top edge while a page is being fetched and drawn.
function progress(on) {
  const el = document.getElementById("progress");
  if (!el) return;
  el.classList.remove("run", "end");
  if (on) { void el.offsetWidth; el.classList.add("run"); }
  else { el.classList.add("end"); setTimeout(() => el.classList.remove("end"), 450); }
}

// Reading-progress line, back-to-top button, help button.
function chrome() {
  const line = document.getElementById("scrollP"), top = document.getElementById("toTop");
  let queued = false;
  const update = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    if (line) line.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max).toFixed(4) : 0})`;
    if (top) top.hidden = scrollY < 700;
  };
  addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  if (top) top.addEventListener("click", () => scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }));
  document.getElementById("helpFab").addEventListener("click", () => openHelp(go));
  pointerEffects();
}

// -------------------------------------------------------------------- boot
async function boot() {
  intro();
  theme();
  chrome();
  try {
    const meta = await getJSON("meta.json", { fresh: true });
    if (meta.schema !== SCHEMA) {
      clear(view).append(h("div", { class: "card headline" }, h("b", { text: "The data on the server is in a newer format than this page understands. " }), "Reload the page; if this message stays, the site needs an update."));
      return;
    }
    const market = await getJSON("market.json");
    ctx = { meta, market };
    strip(market);
    tape(market, go);
    startClock(meta);
    document.getElementById("footMeta").textContent =
      `Model ${meta.model_version} · data updated ${fmtStampIST(meta.generated_at)} · last official session ${fmtDate(meta.last_eod_date)} · no analytics, nothing you type leaves your browser`;
    addEventListener("hashchange", render);
    await render();
    // Pick up a new publish without a manual reload.
    setInterval(async () => {
      try { const fresh = await getJSON("meta.json", { fresh: true }); if (fresh.generated_at !== meta.generated_at) location.reload(); } catch (e) { /* offline */ }
    }, 5 * 60 * 1000);
  } catch (err) {
    clear(view).append(h("div", { class: "card headline" }, h("b", { text: "Market data could not be loaded. " }),
      "Check your connection and reload. ", h("span", { class: "muted", text: String(err.message || err) })));
    document.getElementById("intro").classList.add("done");
  }
}
boot();
