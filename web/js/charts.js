// Charts, drawn as SVG. One y-axis per chart, hairline grid, thin marks, and a
// hover layer on every chart (crosshair on time series, per-mark on bars and dots).
import { clear, fmt, fmtDate, fmtShort, h, hideTip, ok, s, showTip, tipHead, tipNote, tipRow } from "./core.js";

// Re-draw on resize so text stays crisp and never scales with the viewBox.
export function mount(el, draw) {
  let last = 0;
  const run = () => { const w = Math.floor(el.clientWidth); if (w > 0 && w !== last) { last = w; clear(el); draw(w); } };
  new ResizeObserver(run).observe(el);
  run();
}

export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const span = hi - lo, raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function pathOf(points) {
  let d = "", pen = false;
  for (const [x, y] of points) {
    if (!ok(y)) { pen = false; continue; }
    d += (pen ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    pen = true;
  }
  return d;
}

// ------------------------------------------------------------ candle chart
// series: {unit, ref_close, rows:[[date,o,h,l,c]], sma20, sma50, volume}
// levels: [{key, cls, label, value}] in rupees; cone: close quantiles in % vs last close.
export function candleChart(el, series, { levels = [], cone = null, maxBars = 90 } = {}) {
  const api = { highlight() {} };
  mount(el, (W) => {
    const H = W < 520 ? 300 : 380, m = { l: 50, r: 104, t: 14, b: 24 };
    const n = Math.min(series.rows.length, W < 520 ? 45 : maxBars);
    const rows = series.rows.slice(-n), off = series.rows.length - n;
    const inr = series.unit === "inr", ref = series.ref_close;
    const toUnit = (price) => (inr ? price : (price / ref - 1) * 100);
    const fromPct = (p) => (inr ? ref * (1 + p / 100) : p);
    const label = (v) => (inr ? fmt.px(v) : fmt.pct(v, 1));
    const lv = levels.filter((x) => ok(x.value)).map((x) => ({ ...x, y: toUnit(x.value) }));

    let lo = Math.min(...rows.map((r) => r[3])), hi = Math.max(...rows.map((r) => r[2]));
    const recentLo = Math.min(...rows.slice(-20).map((r) => r[3])), recentHi = Math.max(...rows.slice(-20).map((r) => r[2]));
    const reach = (recentHi - recentLo) * 1.2;
    for (const x of lv) if (x.y > recentLo - reach && x.y < recentHi + reach) { lo = Math.min(lo, x.y); hi = Math.max(hi, x.y); }
    if (cone) { lo = Math.min(lo, fromPct(cone.p05)); hi = Math.max(hi, fromPct(cone.p95)); }
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;

    const volH = 34, plotB = H - m.b - volH - 6;
    const coneW = cone ? 30 : 0;
    const plotR = W - m.r - coneW;
    const step = (plotR - m.l) / n, cw = Math.max(1.5, Math.min(9, step * 0.62));
    const X = (i) => m.l + step * (i + 0.5), Y = scale(lo, hi, plotB, m.t);

    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img",
      "aria-label": `Daily candles for the last ${n} sessions with plan levels` });
    for (const t of niceTicks(lo, hi, 5)) {
      svg.append(s("line", { class: "grid", x1: m.l, x2: W - m.r + 4, y1: Y(t), y2: Y(t) }),
                 s("text", { x: m.l - 7, y: Y(t) + 3.5, "text-anchor": "end", text: label(t) }));
    }
    const every = Math.max(1, Math.round(n / (W < 520 ? 3 : 7)));
    rows.forEach((r, i) => { if ((n - 1 - i) % every === 0) svg.append(s("text", { x: X(i), y: H - 7, "text-anchor": "middle", text: fmtShort(r[0]) })); });

    const vol = series.volume.slice(-n);
    vol.forEach((v, i) => { if (ok(v)) svg.append(s("rect", { class: "vol", x: X(i) - cw / 2, width: cw, y: H - m.b - volH * v, height: Math.max(0.5, volH * v) })); });

    for (const [key, cls] of [["sma50", "line s2 thin"], ["sma20", "line s1 thin"]]) {
      const pts = series[key].slice(-n).map((v, i) => [X(i), ok(v) ? Y(v) : null]);
      svg.append(s("path", { class: cls, d: pathOf(pts) }));
    }
    rows.forEach((r, i) => {
      const [, o, hi_, lo_, c] = r, up = c >= o;
      const g = s("g", { class: "candle " + (up ? "up" : "dn"), style: `animation-delay:${Math.min(i * 5, 420)}ms` });
      g.append(s("line", { class: "wick", x1: X(i), x2: X(i), y1: Y(hi_), y2: Y(lo_) }),
               s("rect", { class: "body", x: X(i) - cw / 2, width: cw, y: Y(Math.max(o, c)), height: Math.max(1, Math.abs(Y(o) - Y(c))) }));
      svg.append(g);
    });

    if (cone) {
      const x0 = plotR + 6, x1 = plotR + coneW - 2, y = (p) => Y(fromPct(p));
      svg.append(
        s("rect", { class: "cone-outer", x: x0, width: x1 - x0, y: y(cone.p95), height: y(cone.p05) - y(cone.p95), rx: 3 }),
        s("rect", { class: "cone-inner", x: x0, width: x1 - x0, y: y(cone.p75), height: y(cone.p25) - y(cone.p75), rx: 3 }),
        s("line", { class: "cone-mid", x1: x0, x2: x1, y1: y(cone.p50), y2: y(cone.p50) }),
        s("text", { x: (x0 + x1) / 2, y: m.t - 1, "text-anchor": "middle", text: "next" }));
    }

    const lvNodes = {};
    const placed = [];
    for (const x of lv.slice().sort((a, b) => b.y - a.y)) {
      const y = Y(x.y);
      if (y < m.t - 4 || y > plotB + 4) continue;
      let ly = y + 3.5;
      while (placed.some((p) => Math.abs(p - ly) < 11)) ly += 11;          // keep labels from colliding
      placed.push(ly);
      const g = s("g", { class: `lvl ${x.cls}` },
        s("line", { x1: m.l, x2: W - m.r + 4, y1: y, y2: y }),
        s("text", { x: W - m.r + 8, y: ly, text: x.label }));
      lvNodes[x.key] = g;
      svg.append(g);
    }
    api.highlight = (key) => {
      for (const [k, g] of Object.entries(lvNodes)) {
        g.classList.toggle("hot", key === k);
        g.classList.toggle("dim", key != null && key !== k);
      }
    };

    const hair = s("line", { class: "xhair", y1: m.t, y2: H - m.b, visibility: "hidden" });
    svg.append(hair);
    const hit = s("rect", { x: m.l, y: m.t, width: plotR - m.l, height: H - m.b - m.t, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - box.left - m.l) / step)));
      const [d, o, hi_, lo_, c] = rows[i];
      hair.setAttribute("x1", X(i)); hair.setAttribute("x2", X(i)); hair.setAttribute("visibility", "visible");
      const prev = i + off > 0 ? series.rows[i + off - 1][4] : null;
      const chg = prev == null ? null : inr ? (c / prev - 1) * 100 : ((1 + c / 100) / (1 + prev / 100) - 1) * 100;
      showTip(e, tipHead(fmtDate(d, true)), tipRow("Open", label(o)), tipRow("High", label(hi_)),
              tipRow("Low", label(lo_)), tipRow("Close", label(c)), chg == null ? null : tipRow("Day change", fmt.pct(chg)),
              inr ? null : tipNote("Shown in % relative to the latest close."));
    });
    hit.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); hideTip(); });
    svg.append(hit);
    el.append(svg);
  });
  return api;
}

// --------------------------------------------------------------- histogram
// dist: {lo, hi, counts, n} of outcomes in %; markers: [{value, label, cls}]
export function histogram(el, dist, markers = []) {
  mount(el, (W) => {
    const H = 190, m = { l: 8, r: 8, t: 22, b: 24 };
    const k = dist.counts.length, max = Math.max(...dist.counts), bw = (W - m.l - m.r) / k;
    const X = scale(dist.lo, dist.hi, m.l, W - m.r), Y = scale(0, max, H - m.b, m.t);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Distribution of next-session outcomes on similar past days" });
    svg.append(s("line", { class: "axis", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
    for (const t of niceTicks(dist.lo, dist.hi, W < 420 ? 4 : 7))
      svg.append(s("text", { x: X(t), y: H - 7, "text-anchor": "middle", text: fmt.pct(t, 1) }));
    dist.counts.forEach((c, i) => {
      const a = dist.lo + ((dist.hi - dist.lo) * i) / k, b = dist.lo + ((dist.hi - dist.lo) * (i + 1)) / k;
      const x = m.l + i * bw, y = Y(c), hgt = H - m.b - y;
      const bar = s("path", { class: "bar" + ((a + b) / 2 < 0 ? " neg" : ""),
        d: hgt > 4 ? `M${x + 1},${H - m.b}V${y + 3}q0,-3 3,-3H${x + bw - 4}q3,0 3,3V${H - m.b}Z` : `M${x + 1},${H - m.b}V${y}H${x + bw - 1}V${H - m.b}Z` });
      const hit = s("rect", { class: "hit", x, y: m.t, width: bw, height: H - m.b - m.t, fill: "transparent", tabindex: -1 });
      hit.addEventListener("pointermove", (e) => showTip(e, tipHead(`${fmt.pct(a, 1)} to ${fmt.pct(b, 1)}`),
        tipRow("Similar days", String(c)), tipRow("Share", fmt.prob(c / dist.n, 1))));
      hit.addEventListener("pointerleave", hideTip);
      svg.append(hit, bar);
    });
    for (const mk of markers.filter((x) => ok(x.value) && x.value >= dist.lo && x.value <= dist.hi)) {
      svg.append(s("line", { class: mk.cls || "axis", x1: X(mk.value), x2: X(mk.value), y1: m.t - 4, y2: H - m.b, "stroke-width": 1.5 }),
                 s("text", { x: X(mk.value), y: m.t - 8, "text-anchor": "middle", text: mk.label }));
    }
    el.append(svg);
  });
}

// ------------------------------------------------------------- calibration
// bins: [{bin:[lo,hi], n, predicted, realised, ci:[lo,hi]}]
export function calibrationChart(el, bins, { lo = 0, hi = 1, what = "predicted" } = {}) {
  mount(el, (W) => {
    const H = Math.min(300, Math.max(220, W * 0.62)), m = { l: 38, r: 12, t: 12, b: 34 };
    const X = scale(lo, hi, m.l, W - m.r), Y = scale(lo, hi, H - m.b, m.t);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Calibration: predicted probability against what happened" });
    for (const t of niceTicks(lo, hi, 5)) {
      svg.append(s("line", { class: "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }),
                 s("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end", text: fmt.prob(t) }),
                 s("text", { x: X(t), y: H - m.b + 14, "text-anchor": "middle", text: fmt.prob(t) }));
    }
    svg.append(s("line", { class: "diag", x1: X(lo), y1: Y(lo), x2: X(hi), y2: Y(hi) }),
               s("text", { x: (m.l + W - m.r) / 2, y: H - 4, "text-anchor": "middle", text: `${what} probability` }),
               s("text", { x: X(hi) - 4, y: Y(hi) + 14, "text-anchor": "end", text: "perfect" }));
    for (const b of bins) {
      const cx = X(b.predicted), cy = Y(b.realised);
      if (b.ci) svg.append(s("line", { class: "axis", x1: cx, x2: cx, y1: Y(b.ci[0]), y2: Y(b.ci[1]), "stroke-width": 1.5 }));
      const dot = s("circle", { class: "dot", cx, cy, r: 5 });
      const hit = s("circle", { cx, cy, r: 14, fill: "transparent" });
      hit.addEventListener("pointermove", (e) => showTip(e, tipHead(`Predicted ${fmt.prob(b.bin[0])} to ${fmt.prob(b.bin[1])}`),
        tipRow("Average predicted", fmt.prob(b.predicted, 1)), tipRow("Happened", fmt.prob(b.realised, 1)),
        tipRow("Cases", fmt.int(b.n)), b.ci ? tipRow("95% range", `${fmt.prob(b.ci[0], 1)} to ${fmt.prob(b.ci[1], 1)}`) : null));
      hit.addEventListener("pointerleave", hideTip);
      svg.append(dot, hit);
    }
    el.append(svg);
  });
}

// ------------------------------------------------------------- line chart
// lines: [{name, cls, points:[[isoDate, y]]}] on one shared y-axis.
export function lineChart(el, lines, { unit = (v) => fmt.signed(v, 0) + " R", zero = true } = {}) {
  mount(el, (W) => {
    const H = 280, m = { l: 8, r: 64, t: 14, b: 24 };
    const dates = [...new Set(lines.flatMap((l) => l.points.map((p) => p[0])))].sort();
    if (!dates.length) { el.append(h("p", { class: "muted small", text: "Nothing to plot yet." })); return; }
    const idx = new Map(dates.map((d, i) => [d, i]));
    const ys = lines.flatMap((l) => l.points.map((p) => p[1]));
    let lo = Math.min(...ys, zero ? 0 : Infinity), hi = Math.max(...ys, zero ? 0 : -Infinity);
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const X = scale(0, Math.max(1, dates.length - 1), m.l, W - m.r), Y = scale(lo, hi, H - m.b, m.t);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Cumulative result of each rule over time" });
    for (const t of niceTicks(lo, hi, 5))
      svg.append(s("line", { class: t === 0 ? "axis" : "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }),
                 s("text", { x: W - 4, y: Y(t) + 3.5, "text-anchor": "end", text: unit(t) }));
    const every = Math.max(1, Math.round(dates.length / (W < 520 ? 3 : 6)));
    dates.forEach((d, i) => { if (i % every === 0) svg.append(s("text", { x: X(i), y: H - 7, "text-anchor": i === 0 ? "start" : "middle", text: fmtShort(d) + " '" + d.slice(2, 4) })); });
    const maps = lines.map((l) => new Map(l.points));
    lines.forEach((l) => {
      const p = s("path", { class: `line ${l.cls} draw`, d: pathOf(l.points.map(([d, y]) => [X(idx.get(d)), Y(y)])) });
      svg.append(p);
      requestAnimationFrame(() => { try { p.style.setProperty("--len", p.getTotalLength()); } catch (e) { p.classList.remove("draw"); } });
      const last = l.points[l.points.length - 1];
      if (last) svg.append(s("circle", { class: "dot", cx: X(idx.get(last[0])), cy: Y(last[1]), r: 4, style: `fill:var(--${l.cls === "base" ? "muted" : l.cls})` }));
    });
    const hair = s("line", { class: "xhair", y1: m.t, y2: H - m.b, visibility: "hidden" });
    const hit = s("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.b - m.t, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(dates.length - 1, Math.round(((e.clientX - box.left - m.l) / (W - m.l - m.r)) * (dates.length - 1))));
      hair.setAttribute("x1", X(i)); hair.setAttribute("x2", X(i)); hair.setAttribute("visibility", "visible");
      // carry each line's last known value forward to this date
      const rowsOut = lines.map((l, k) => {
        let v = null;
        for (let j = i; j >= 0 && v == null; j--) if (maps[k].has(dates[j])) v = maps[k].get(dates[j]);
        return tipRow(l.name, v == null ? "-" : unit(v));
      });
      showTip(e, tipHead(fmtDate(dates[i], true)), rowsOut);
    });
    hit.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); hideTip(); });
    svg.append(hair, hit);
    el.append(svg);
  });
}

// --------------------------------------------------------- forecast vs real
// rows: from comparelogic.stockSeries. unit "inr": rupees (range bars from that day's previous
// close, real close joined by a line); "pct": % change from the previous close.
export function compareChart(el, rows, { unit = "inr", onPick = null } = {}) {
  const api = { highlight() {} };
  mount(el, (W) => {
    if (!rows.length) { el.append(h("p", { class: "muted small", text: "Nothing to plot for this choice." })); return; }
    const inr = unit === "inr", H = W < 520 ? 300 : 360, m = { l: inr ? 64 : 48, r: 14, t: 22, b: 26 };
    const lo_ = (r) => (inr ? r.lo : r.p05), hi_ = (r) => (inr ? r.hi : r.p95), mid_ = (r) => (inr ? r.mid : r.p50), act_ = (r) => (inr ? r.close : r.ret);
    let lo = Math.min(...rows.map((r) => Math.min(lo_(r), act_(r)))), hi = Math.max(...rows.map((r) => Math.max(hi_(r), act_(r))));
    if (!inr) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const n = rows.length, step = (W - m.l - m.r) / n, bw = Math.max(2, Math.min(14, step * 0.58));
    const X = (i) => m.l + step * (i + 0.5), Y = scale(lo, hi, H - m.b, m.t);
    const label = (v) => (inr ? fmt.px(v) : fmt.pct(v, 1));
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img",
      "aria-label": `Predicted 90% range and real close for ${n} sessions` });

    rows.forEach((r, i) => { if (r.track === "live") svg.append(s("rect", { class: "live-col", x: X(i) - step / 2, width: step, y: m.t - 14, height: H - m.b - m.t + 14 })); });
    const firstLive = rows.findIndex((r) => r.track === "live");
    if (firstLive >= 0) svg.append(s("text", { class: "live-tag", x: X(firstLive), y: m.t - 4, "text-anchor": firstLive > n - 3 ? "end" : "middle", text: "LIVE" }));
    for (const t of niceTicks(lo, hi, 5))
      svg.append(s("line", { class: !inr && t === 0 ? "axis" : "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }),
                 s("text", { x: m.l - 7, y: Y(t) + 3.5, "text-anchor": "end", text: label(t) }));
    const every = Math.max(1, Math.round(n / (W < 520 ? 3 : 7)));
    rows.forEach((r, i) => { if ((n - 1 - i) % every === 0) svg.append(s("text", { x: X(i), y: H - 8, "text-anchor": "middle", text: fmtShort(r.date) })); });

    const bars = s("g", { class: "cmp-bars" });
    rows.forEach((r, i) => {
      const y1 = Y(hi_(r)), y0 = Y(lo_(r));
      bars.append(s("rect", { class: "cmp-band" + (r.inside ? "" : " miss"), x: X(i) - bw / 2, width: bw, y: y1, height: Math.max(2, y0 - y1), rx: Math.min(3, bw / 2),
                              style: `animation-delay:${Math.min(i * 12, 600)}ms` }),
                  s("line", { class: "cmp-mid", x1: X(i) - bw / 2, x2: X(i) + bw / 2, y1: Y(mid_(r)), y2: Y(mid_(r)) }));
    });
    svg.append(bars);
    if (inr) {
      const p = s("path", { class: "line cmp-real draw", d: pathOf(rows.map((r, i) => [X(i), Y(r.close)])) });
      svg.append(p);
      requestAnimationFrame(() => { try { p.style.setProperty("--len", p.getTotalLength()); } catch (e) { p.classList.remove("draw"); } });
    }
    const dots = rows.map((r, i) => {
      const d = s("circle", { class: "cmp-dot " + (r.inside ? "in" : "out"), cx: X(i), cy: Y(act_(r)), r: r.inside ? 3.4 : 4.6, style: `animation-delay:${300 + Math.min(i * 12, 600)}ms` });
      svg.append(d);
      return d;
    });

    const hair = s("line", { class: "xhair", y1: m.t, y2: H - m.b, visibility: "hidden" });
    const hit = s("rect", { x: m.l, y: m.t - 14, width: W - m.l - m.r, height: H - m.b - m.t + 14, fill: "transparent" });
    let hot = -1;
    const focus = (i, e) => {
      if (hot >= 0 && dots[hot]) dots[hot].classList.remove("hot");
      hot = i;
      if (i < 0) { hair.setAttribute("visibility", "hidden"); hideTip(); return; }
      const r = rows[i];
      dots[i].classList.add("hot");
      hair.setAttribute("x1", X(i)); hair.setAttribute("x2", X(i)); hair.setAttribute("visibility", "visible");
      const money = (pct) => fmt.px(r.prev * (1 + pct / 100));
      if (e) showTip(e, tipHead(`${fmtDate(r.date, true)} · ${r.track === "live" ? "live" : "backtest"}`),
        tipRow("Predicted range", inr ? `${money(r.p05)} to ${money(r.p95)}` : `${fmt.pct(r.p05, 1)} to ${fmt.pct(r.p95, 1)}`),
        tipRow("Most likely", inr ? money(r.p50) : fmt.pct(r.p50, 1)),
        tipRow("Real close", inr ? `${fmt.px(r.close)} (${fmt.pct(r.ret)})` : fmt.pct(r.ret)),
        tipRow("Inside the range", r.inside ? "yes ✓" : `no ✗ (${fmt.pct(r.outsideBy, 1)} beyond)`),
        r.pUp != null ? tipRow("Chance up it gave", fmt.prob(r.pUp)) : null,
        r.right != null ? tipRow("Up/down lean", r.right ? "right ✓" : "wrong ✗") : null);
    };
    hit.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      focus(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - box.left - m.l) / step))), e);
    });
    hit.addEventListener("pointerleave", () => focus(-1));
    if (onPick) hit.addEventListener("click", () => { if (hot >= 0) onPick(rows[hot]); });
    svg.append(hair, hit);
    el.append(svg);
    api.highlight = (i) => {
      if (i < 0) { focus(-1); return; }
      const box = svg.getBoundingClientRect();
      focus(i, { clientX: box.left + X(i), clientY: box.top + Y(act_(rows[i])) });
    };
  });
  return api;
}

// series: comparelogic.marketSeries. Bars = share of the 50 closes inside their range (aim 90%);
// line = share whose up/down lean was right (a coin flip is 50%).
export function scoreChart(el, series) {
  mount(el, (W) => {
    if (!series.length) { el.append(h("p", { class: "muted small", text: "Nothing to plot yet." })); return; }
    const H = 280, m = { l: 40, r: 64, t: 18, b: 26 }, n = series.length;
    const step = (W - m.l - m.r) / n, bw = Math.max(2, Math.min(12, step * 0.55));
    const X = (i) => m.l + step * (i + 0.5), Y = scale(0, 1, H - m.b, m.t);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Daily accuracy across all stocks" });
    series.forEach((d, i) => { if (d.track === "live") svg.append(s("rect", { class: "live-col", x: X(i) - step / 2, width: step, y: m.t - 10, height: H - m.b - m.t + 10 })); });
    for (const t of [0, 0.25, 0.5, 0.75, 1])
      svg.append(s("line", { class: "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }), s("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end", text: fmt.prob(t) }));
    const every = Math.max(1, Math.round(n / (W < 520 ? 3 : 7)));
    series.forEach((d, i) => { if ((n - 1 - i) % every === 0) svg.append(s("text", { x: X(i), y: H - 8, "text-anchor": "middle", text: fmtShort(d.date) })); });
    series.forEach((d, i) => svg.append(s("rect", { class: "score-bar" + (d.coverage < 0.8 ? " low" : ""), x: X(i) - bw / 2, width: bw, y: Y(d.coverage), height: Math.max(1, Y(0) - Y(d.coverage)), rx: Math.min(2.5, bw / 2), style: `animation-delay:${Math.min(i * 10, 600)}ms` })));
    for (const [v, cls, text] of [[0.9, "ref-cov", "aim 90%"], [0.5, "ref-coin", "coin flip"]])
      svg.append(s("line", { class: cls, x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }), s("text", { class: cls + "-t", x: W - m.r + 6, y: Y(v) + 3.5, text }));
    const p = s("path", { class: "line s2 draw", d: pathOf(series.map((d, i) => [X(i), Y(d.dirHit)])) });
    svg.append(p);
    requestAnimationFrame(() => { try { p.style.setProperty("--len", p.getTotalLength()); } catch (e) { p.classList.remove("draw"); } });
    series.forEach((d, i) => svg.append(s("circle", { class: "dot s2dot", cx: X(i), cy: Y(d.dirHit), r: n > 40 ? 2.4 : 3.4 })));
    const hair = s("line", { class: "xhair", y1: m.t, y2: H - m.b, visibility: "hidden" });
    const hit = s("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.b - m.t, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - box.left - m.l) / step))), d = series[i];
      hair.setAttribute("x1", X(i)); hair.setAttribute("x2", X(i)); hair.setAttribute("visibility", "visible");
      showTip(e, tipHead(`${fmtDate(d.date, true)} · ${d.track === "live" ? "live" : "backtest"}`),
        tipRow("Closes inside the range", `${fmt.prob(d.coverage)} of ${d.n}`), tipRow("Up/down lean right", fmt.prob(d.dirHit)),
        d.upShare != null ? tipRow("Stocks that rose", fmt.prob(d.upShare)) : null, d.avgRet != null ? tipRow("Average move", fmt.pct(d.avgRet)) : null);
    });
    hit.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); hideTip(); });
    svg.append(hair, hit);
    el.append(svg);
  });
}

// ------------------------------------------------------------------- ring
export function ring(value, label) {
  const r = 38, c = 2 * Math.PI * r, v = ok(value) ? Math.max(0, Math.min(100, value)) : 0;
  const arc = s("circle", { class: "arc", cx: 46, cy: 46, r, "stroke-dasharray": c, "stroke-dashoffset": c });
  const svg = s("svg", { viewBox: "0 0 92 92", role: "img", "aria-label": `${label}: ${ok(value) ? Math.round(value) : "not available"} out of 100` },
    s("circle", { class: "trk", cx: 46, cy: 46, r }), arc,
    s("text", { x: 46, y: 53, "text-anchor": "middle", text: ok(value) ? String(Math.round(value)) : "-" }));
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute("stroke-dashoffset", c * (1 - v / 100))));
  return svg;
}
