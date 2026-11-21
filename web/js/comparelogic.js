// "Accuracy check": lines the published forecast up against the real close.
// Only counts and averages what compare.json already holds. No page dependencies,
// so it runs under Node for tests.

import { dailyReader, rowReader } from "./comparerow.js";

const fin = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
export const PERIODS = { 20: "Last 20 days", 60: "Last 60 days", all: "Everything" };
export const MIN_DAYS = 10;          // separate sessions needed before the page gives a verdict

// Rows of one stock as objects, oldest first, limited to the last `period` days of the file.
export function stockSeries(data, symbol, period = "all") {
  if (!data || !Array.isArray(data.days) || !data.stocks || !data.stocks[symbol]) return [];
  const first = period === "all" ? 0 : Math.max(0, data.days.length - Number(period));
  const read = rowReader(data);
  const out = [];
  for (const raw of data.stocks[symbol]) {
    const o = read(raw);
    if (!o) continue;
    const { day: i, prev, p05, p50, p95, close, ret, p_up: pUp, right, inside } = o;
    if (i < first || !o.date || ![prev, p05, p50, p95, close, ret].every(fin) || !(prev > 0)) continue;
    const px = (p) => prev * (1 + p / 100);
    out.push({
      date: o.date, track: o.track, prev, p05, p50, p95, close, ret,
      lo: px(p05), mid: px(p50), hi: px(p95), pUp: fin(pUp) ? pUp : null,
      right: right == null ? null : !!right, inside: inside == null ? ret >= p05 && ret <= p95 : !!inside,
      rightOpen: o.right_open == null ? null : !!o.right_open,
      missPct: ret - p50, missRs: close - px(p50),
      // How far outside the range the close landed (0 when inside), in % of the previous close.
      outsideBy: ret > p95 ? ret - p95 : ret < p05 ? ret - p05 : 0,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Whole market, one entry per day.
export function marketSeries(data, period = "all") {
  if (!data || !Array.isArray(data.days) || !Array.isArray(data.daily)) return [];
  const first = period === "all" ? 0 : Math.max(0, data.days.length - Number(period));
  const read = dailyReader(data);
  const out = [];
  data.days.forEach((date, i) => {
    const d = read(data.daily[i], i);
    if (i < first || !d) return;
    if (!fin(d.dir_hit) || !fin(d.coverage)) return;
    out.push({ date, track: d.track, dirHit: d.dir_hit, dirHitOpen: fin(d.dir_hit_open) ? d.dir_hit_open : null, coverage: d.coverage,
      upShare: fin(d.up_share) ? d.up_share : null, avgRet: fin(d.avg_ret) ? d.avg_ret : null, n: d.n || 0 });
  });
  return out;
}

// Every stock-day in the period, for totals across the whole market.
export function allRows(data, period = "all") {
  return Object.keys((data && data.stocks) || {}).flatMap((s) => stockSeries(data, s, period).map((r) => ({ ...r, symbol: s })));
}

export function summarize(rows) {
  const list = (rows || []).filter((r) => r && fin(r.ret));
  if (!list.length) return null;
  const withDir = list.filter((r) => r.right != null);
  const inside = list.filter((r) => r.inside).length;
  const ups = list.filter((r) => r.ret > 0).length;
  const right = withDir.filter((r) => r.right).length;
  const misses = list.slice().sort((a, b) => Math.abs(b.outsideBy) - Math.abs(a.outsideBy) || Math.abs(b.missPct) - Math.abs(a.missPct));
  let streak = 0;
  for (let i = list.length - 1; i >= 0 && list[i].inside; i--) streak++;
  return {
    n: list.length, live: list.filter((r) => r.track === "live").length,
    days: new Set(list.map((r) => r.date)).size,
    inside, coverage: inside / list.length,
    right, dirN: withDir.length, hit: withDir.length ? right / withDir.length : null,
    ...(() => { const o = list.filter((r) => r.rightOpen != null); const k = o.filter((r) => r.rightOpen).length;
      return { rightOpen: k, openN: o.length, hitOpen: o.length ? k / o.length : null }; })(),
    alwaysUp: ups / list.length,
    avgMissPct: mean(list.map((r) => Math.abs(r.missPct))),
    avgMissRs: mean(list.filter((r) => fin(r.missRs)).map((r) => Math.abs(r.missRs))),
    avgWidth: mean(list.map((r) => r.p95 - r.p05)),
    biggest: misses[0],
    above: list.filter((r) => r.outsideBy > 0).length, below: list.filter((r) => r.outsideBy < 0).length,
    insideStreak: streak,
  };
}

// Plain sentences a newcomer can read. `s` from summarize(); `who` e.g. "RELIANCE" or "all 50 stocks".
export function verdict(s, who) {
  if (!s) return { range: "There is nothing to compare yet.", direction: "", grade: "none", dirGrade: "none" };
  const pct = (x) => Math.round(x * 100) + "%";
  // Stocks on the same day move together, so 50 stocks on one day are nearly one observation:
  // judge only after enough separate days.
  const days = s.days == null ? s.n : s.days;
  const tooFew = s.n < 20 || days < MIN_DAYS;
  const covGrade = tooFew ? "early" : s.coverage >= 0.86 && s.coverage <= 0.95 ? "good" : s.coverage > 0.95 ? "wide" : "narrow";
  const rangeText = {
    early: `So far the real close landed inside the predicted range ${s.inside} out of ${s.n} times, over ${days} day${days === 1 ? "" : "s"}. That is too little to judge; check back after about ${MIN_DAYS} days.`,
    good: `The real close landed inside the predicted range ${s.inside} out of ${s.n} times (${pct(s.coverage)}). That is close to the 9 out of 10 the tool aims for, so its ranges were about right.`,
    wide: `The real close landed inside the predicted range ${s.inside} out of ${s.n} times (${pct(s.coverage)}). That is more than the 9 in 10 aimed for: the ranges were a little too cautious (wider than needed).`,
    narrow: `The real close landed inside the predicted range only ${s.inside} out of ${s.n} times (${pct(s.coverage)}). The aim is 9 in 10, so the ranges were too narrow: the market moved more than expected.`,
  }[covGrade];
  let dirGrade = "early", direction = "";
  if (s.dirN) {
    const edge = s.hit - Math.max(s.alwaysUp, 1 - s.alwaysUp);
    dirGrade = s.dirN < 30 || days < MIN_DAYS ? "early" : edge > 0.02 ? "good" : edge > -0.02 ? "even" : "worse";
    const base = s.alwaysUp >= 0.5 ? `Simply guessing “up” every time would have been right ${pct(s.alwaysUp)}` : `Simply guessing “down” every time would have been right ${pct(1 - s.alwaysUp)}`;
    direction = `Its up-or-down lean was right ${s.right} out of ${s.dirN} times (${pct(s.hit)}). ${base}, so ` + {
      early: "it is too early to tell whether the lean helps.",
      good: "the lean added a little over a plain guess.",
      even: "the lean was about as good as a plain guess.",
      worse: "the lean did worse than a plain guess over this period.",
    }[dirGrade];
    if (s.openN) direction += ` Measured from the opening price, which is what a trader could still act on after 9:15 AM, it was right ${s.rightOpen} out of ${s.openN} times (${pct(s.hitOpen)}).`;
  }
  return { range: rangeText, direction, grade: covGrade, dirGrade, who };
}
