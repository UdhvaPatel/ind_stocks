// Core helpers: DOM, India-time clock, number formats, data loading, tooltip, preferences.
// Everything shown on the site is in India Standard Time, whatever the viewer's own time zone is.

export const IST = "Asia/Kolkata";
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------- DOM
function build(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "vars") for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k === "data") for (const [n, val] of Object.entries(v)) el.dataset[n] = val;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));   // data is always text, never HTML
  }
  return el;
}
export const h = (tag, attrs, ...kids) => build(document.createElement(tag), attrs, kids);
export const s = (tag, attrs, ...kids) => build(document.createElementNS(SVG_NS, tag), attrs, kids);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function icon(name) {
  const paths = {
    check: "M4 12.5l5 5L20 6.5",
    cross: "M6 6l12 12M18 6L6 18",
    minus: "M5 12h14",
    pause: "M8 5v14M16 5v14",
    info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
    up: "M12 19V5m-6 6 6-6 6 6",
    down: "M12 5v14m-6-6 6 6 6-6",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4",
  };
  return s("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: paths[name] || paths.info }));
}

// ---------------------------------------------------------------- India time
const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
export function istNow(d = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  const hh = +p.hour, mm = +p.minute, ss = +p.second;
  return { date: `${p.year}-${p.month}-${p.day}`, h: hh, m: mm, s: ss, minutes: hh * 60 + mm,
           weekday: p.weekday, clock: `${p.hour}:${p.minute}:${p.second}` };
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Calendar dates are plain "YYYY-MM-DD" strings; formatting them never involves a time zone.
export function fmtDate(iso, withDay = false) {
  if (!iso) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const base = `${String(d).padStart(2, "0")}-${MONTHS[m - 1]}-${y}`;
  return withDay ? `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${base}` : base;
}
export const fmtShort = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
// A timestamp (with offset) shown as India time.
export function fmtStampIST(isoStamp) {
  if (!isoStamp) return "-";
  const p = istNow(new Date(isoStamp));
  return `${fmtDate(p.date)} ${String(p.h).padStart(2, "0")}:${String(p.m).padStart(2, "0")} IST`;
}

// ------------------------------------------------------------------ numbers
const inr0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ok = (x) => x != null && Number.isFinite(+x);
export const fmt = {
  px: (x) => (ok(x) ? inr2.format(x) : "-"),                                  // 1,339.70
  rs: (x) => (ok(x) ? "₹" + inr0.format(Math.round(x)) : "-"),           // ₹1,00,000
  rs2: (x) => (ok(x) ? "₹" + inr2.format(x) : "-"),
  signedRs: (x) => (ok(x) ? (x < 0 ? "−" : "+") + "₹" + inr0.format(Math.abs(Math.round(x))) : "-"),
  int: (x) => (ok(x) ? inr0.format(x) : "-"),
  num: (x, d = 2) => (ok(x) ? (+x).toFixed(d) : "-"),
  pct: (x, d = 2) => (ok(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%" : "-"),
  pct0: (x, d = 0) => (ok(x) ? (+x).toFixed(d) + "%" : "-"),                   // unsigned share
  prob: (p, d = 0) => (!ok(p) ? "-" : d === 0 && p > 0 && p < 0.005 ? "<1%" : (p * 100).toFixed(d) + "%"),
  r: (x, d = 2) => (ok(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + " R" : "-"),
  signed: (x, d = 2) => (ok(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) : "-"),
};
export const dir = (x) => (!ok(x) || x === 0 ? "flat" : x > 0 ? "up" : "down");
export const arrow = (x) => (!ok(x) || x === 0 ? "" : x > 0 ? "▲" : "▼");
export { ok };

// --------------------------------------------------------------------- data
let base = null;
const cache = new Map();
// The published site keeps data/ next to index.html; a local preview serves the project root,
// so the page is at /web/ and data at ../data/. Knowing this saves a probe request on every load.
function guessBase() {
  try { return /\/web\/[^/]*$/.test(location.pathname) ? "../data/" : "data/"; } catch (e) { return null; }
}
async function findBase() {
  const guess = guessBase();
  if (guess) return guess;
  for (const b of ["data/", "../data/"]) {
    try { const r = await fetch(b + "meta.json", { cache: "no-store" }); if (r.ok) return b; } catch (e) { /* try next */ }
  }
  throw new Error("The data files could not be found.");
}
export async function getJSON(path, { fresh = false, optional = false } = {}) {
  if (!base) base = await findBase();
  if (!fresh && cache.has(path)) return cache.get(path);
  const p = fetch(base + path, { cache: "no-cache" }).then((r) => {
    if (!r.ok) { if (optional) return null; throw new Error(`${path}: ${r.status}`); }
    return r.json();
  });
  cache.set(path, p);
  try { return await p; } catch (e) { cache.delete(path); if (optional) return null; throw e; }
}
export const symbolFile = (sym) => `symbols/${sym.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
export const SCHEMA = 1;

// ------------------------------------------------------------------ tooltip
const tipEl = () => document.getElementById("tip");
export function showTip(evt, ...nodes) {
  const el = tipEl();
  clear(el).append(...nodes.flat());
  el.hidden = false;
  const pad = 14, r = el.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  el.style.left = Math.max(8, x) + "px";
  el.style.top = Math.max(8, y) + "px";
}
export const hideTip = () => { tipEl().hidden = true; };
export const tipRow = (label, value) => h("div", { class: "t-r" }, h("span", { text: label }), h("b", { text: value }));
export const tipHead = (text) => h("div", { class: "t-h", text });
export const tipNote = (text) => h("div", { class: "t-n", text });
// Hover and keyboard focus show the same tooltip.
export function withTip(el, make) {
  el.addEventListener("pointermove", (e) => showTip(e, make()));
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); showTip({ clientX: r.left + r.width / 2, clientY: r.bottom }, make()); });
  el.addEventListener("blur", hideTip);
  return el;
}

// -------------------------------------------------------------- preferences
export const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem("dd-" + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem("dd-" + key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
};

// ------------------------------------------------------------------- motion
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { rootMargin: "0px 0px -6% 0px" });
export function reveal(root) {
  root.querySelectorAll(".reveal:not(.in)").forEach((el, i) => { el.style.transitionDelay = Math.min(i * 45, 360) + "ms"; io.observe(el); });
}
// Roll a number up to its value.
export function countUp(el, to, format, ms = 700) {
  if (!ok(to) || reduced()) { el.textContent = format(to); return; }
  const t0 = performance.now(), from = 0;
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    el.textContent = format(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Money arithmetic lives in money.js (no page dependencies) and is re-exported here.
export { charges, position } from "./money.js";
