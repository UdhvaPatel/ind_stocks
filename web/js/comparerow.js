// The one reader for compare.json and data/compare/*.json rows. Columns are looked up by
// name from the file's own "cols" list, so adding a column never shifts anything.
// Files written before the layout carried names fall back to the original order.

export const LEGACY_COLS = ["day", "prev", "p05", "p50", "p95", "close", "ret", "p_up", "right", "inside",
  "kind", "status", "plan_ret", "entry", "stop", "rules", "advice"];
export const LEGACY_RULES = ["breakout", "pullback", "gap_reversal"];
export const LEGACY_DAILY = ["dir_hit", "coverage", "up_share", "avg_ret", "n"];
export const KNOWN_LAYOUTS = [1, 2];

export function layoutOf(data) {
  if (!data) return null;
  const layout = data.layout || 1;
  if (!KNOWN_LAYOUTS.includes(layout)) {
    throw new Error("The accuracy data is in a newer format than this page understands. Reload the page.");
  }
  return { layout, cols: data.cols || LEGACY_COLS, rules: data.rule_order || LEGACY_RULES, daily: data.daily_cols || LEGACY_DAILY };
}

// Returns row -> plain object, with `date`, `track` and `rules` ({breakout: x, ...}) filled in.
export function rowReader(data) {
  const L = layoutOf(data);
  if (!L) return () => null;
  const at = Object.fromEntries(L.cols.map((c, i) => [c, i]));
  return (row) => {
    if (!Array.isArray(row)) return null;
    const o = {};
    for (const [c, i] of Object.entries(at)) o[c] = i < row.length ? row[i] : null;
    o.date = data.days ? data.days[o.day] : null;
    o.track = data.track ? data.track[o.day] || "backtest" : "backtest";
    const list = Array.isArray(o.rules) ? o.rules : [];
    o.rules = Object.fromEntries(L.rules.map((k, j) => [k, j < list.length ? list[j] : null]));
    return o;
  };
}

// Returns daily row -> {date, track, dir_hit, coverage, ...}.
export function dailyReader(data) {
  const L = layoutOf(data);
  if (!L) return () => null;
  return (row, i) => {
    if (!Array.isArray(row)) return null;
    const o = { date: data.days[i], track: (data.track && data.track[i]) || "backtest" };
    L.daily.forEach((c, j) => { o[c] = j < row.length ? row[j] : null; });
    return o;
  };
}
