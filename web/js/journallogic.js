// Paper-trading journal: plans a visitor says they "would follow", scored later from the
// published results (compare.json). Stored in this browser only; nothing is sent anywhere.
// Pure functions except load/save, which take a storage object so tests can pass their own.

import { rowReader } from "./comparerow.js";

const KEY = "dd-journal";
const fin = (x) => typeof x === "number" && Number.isFinite(x);
export const RULE_INDEX = { breakout: 0, pullback: 1, gap_reversal: 2 };
export const MAX_ENTRIES = 500;

export function load(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse((storage && storage.getItem(KEY)) || "[]");
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch (e) { return []; }
}
export function save(list, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES))); return true; } catch (e) { return false; }
}

function valid(e) {
  return e && typeof e.symbol === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.forDate || "") && e.kind in RULE_INDEX && fin(e.amount) && e.amount > 0;
}
export const entryId = (e) => `${e.forDate}|${e.symbol}|${e.kind}`;

// Adds the entry (one per stock, day and plan); returns the new list.
export function add(list, e, now = new Date()) {
  const entry = { ...e, id: entryId(e), addedAt: now.toISOString() };
  if (!valid(entry)) throw new Error("This plan cannot be added: some of its details are missing.");
  return [...list.filter((x) => x.id !== entry.id), entry].sort((a, b) => a.forDate.localeCompare(b.forDate) || a.symbol.localeCompare(b.symbol));
}
export const remove = (list, id) => list.filter((x) => x.id !== id);
export const has = (list, e) => list.some((x) => x.id === entryId(e));

// Score each entry from compare.json. Status:
//   pending   : the session has not been scored yet
//   no_trade  : the plan never bought (money unchanged)
//   gain/loss : it bought and sold; money = amount x net % return after charges
//   unknown   : the session is scored but this plan's result was not recorded
//   no_data   : the stock has no scored row for that session (for example a holiday)
export function resolve(list, compare) {
  const days = (compare && compare.days) || [];
  const last = days.length ? days[days.length - 1] : null;
  const read = rowReader(compare);
  const index = {};
  for (const [sym, rows] of Object.entries((compare && compare.stocks) || {})) {
    for (const raw of rows) { const o = read(raw); if (o && o.date) index[`${o.date}|${sym}`] = o; }
  }
  return list.map((e) => {
    const row = index[`${e.forDate}|${e.symbol}`];
    if (!row) return { ...e, status: !last || e.forDate > last ? "pending" : "no_data", money: null };
    let v = row.rules[e.kind];
    if (v == null && row.kind === e.kind) {                         // the plan shown that day carries its own result
      v = ["not_triggered", "cancelled", "none"].includes(row.status) ? "n" : row.plan_ret;
    }
    const close = fin(row.close) ? row.close : null;
    if (v === "n") return { ...e, status: "no_trade", money: 0, close };
    if (!fin(v)) return { ...e, status: "unknown", money: null, close };
    const money = (e.amount * v) / 100;
    return { ...e, status: money > 0 ? "gain" : "loss", money, retPct: v, close };
  });
}

export function summary(resolved) {
  const settled = resolved.filter((e) => e.status === "gain" || e.status === "loss");
  const total = settled.reduce((a, e) => a + e.money, 0);
  const invested = settled.reduce((a, e) => a + e.amount, 0);
  let run = 0;
  const curve = settled.slice().sort((a, b) => a.forDate.localeCompare(b.forDate)).map((e) => { run += e.money; return [e.forDate, Math.round(run * 100) / 100]; });
  return {
    entries: resolved.length, pending: resolved.filter((e) => e.status === "pending").length,
    noTrade: resolved.filter((e) => e.status === "no_trade").length,
    unknown: resolved.filter((e) => e.status === "unknown" || e.status === "no_data").length,
    trades: settled.length, wins: settled.filter((e) => e.money > 0).length, losses: settled.filter((e) => e.money <= 0).length,
    total, avgReturnPct: invested ? (total / invested) * 100 : null,
    best: settled.length ? Math.max(...settled.map((e) => e.money)) : null, worst: settled.length ? Math.min(...settled.map((e) => e.money)) : null,
    curve,
  };
}

export function toCSV(resolved) {
  const head = ["session", "stock", "plan", "amount_rs", "status", "result_rs", "net_return_pct", "added_at"];
  const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [head.join(","), ...resolved.map((e) => [e.forDate, e.symbol, e.kind, e.amount, e.status, e.money == null ? "" : e.money.toFixed(2), e.retPct ?? "", e.addedAt].map(q).join(","))].join("\n") + "\n";
}
