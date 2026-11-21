// How it works: method, limits, data quality, in plain language.
import { clear, fmt, fmtDate, getJSON, h, reveal } from "./core.js";
import { researchSection } from "./research.js";

export async function renderHow(root, ctx) {
  const { meta } = ctx;
  const [q, research] = await Promise.all([getJSON("quality.json", { optional: true }), getJSON("research.json", { optional: true })]);
  const c = meta.costs, v = meta.variants_tried || {};
  const sec = (title, ...kids) => h("section", { class: "card reveal" }, h("div", { class: "card-b" }, h("h2", { text: title }), kids));
  const ul = (...items) => h("ul", {}, items.map((t) => h("li", {}, t)));
  const b = (t) => h("b", { text: t });

  clear(root).append(
    h("div", { class: "page-h" }, h("div", {}, h("h1", { text: "How it works, and its limits" }),
      h("p", { text: "Short-term stock prices are close to a random walk. This tool does not claim to predict them. It writes down scenarios and what-if levels before the market opens, then measures itself in public." }))),
    research ? h("div", { style: { marginBottom: "16px" } }, researchSection(research)) : null,
    h("div", { class: "prose" },
      sec("One session at a time",
        ul(["Around ", b("06:00 IST"), " on each trading day a plan for that day is built from data up to the previous close plus the overnight US market move, and committed to a public ledger. The commit time is the proof that it was written beforehand."],
           ["While the market is open the page does not change. ", b("There are no live prices here.")],
           ["After the official NSE end-of-day file is published, usually after ", b("18:00 IST"), ", the day is scored: what was predicted, what happened, and the updated accuracy. A draft for the next session is shown, and replaced by the committed plan the next morning."],
           ["All times on this site are ", b("India Standard Time"), ", wherever you are reading from."])),
      sec("What the forecast is",
        ul(["For each stock the tool finds past days that looked like today (position in its 60-day range, trend, volatility) and reports what the next session did on those days, scaled to today's volatility."],
           ["The overnight move of the S&P 500 shifts the centre of that picture. It is the only input that has reliably helped with direction."],
           ["Two models (a logistic regression and gradient-boosted trees) are ", b("retrained every week"), " on all data whose outcome was known before that Monday. Their vote counts only as much as their last 250 sessions of real predictions have earned; a model that has not helped gets weight zero."],
           ["Range widths and probabilities are corrected each day using the errors of the previous 250 sessions, so that a “90% range” really contains about 90% of outcomes."])),
      sec("What the plans are, and the uncomfortable finding",
        h("p", {}, "Three simple one-session rules are tracked for every stock every day: a breakout above yesterday's high, a dip toward support, and a gap-down reversal at the open. Positions are sized from the stop, entries stop at 14:30 IST, and everything is closed by 15:15 IST."),
        h("p", {}, b("After realistic costs, none of these rules has shown a reliable edge "), "over ten years of Nifty 50 history. That is why most stocks show “no trade”. A rule is only called for a stock when its own record there, blended with its record across all stocks, is positive. The levels are still shown for reference, each next to its measured record."),
        h("p", { class: "muted small", text: `Honesty count: ${v.plan_types ?? "-"} rule types, ${v.plan_parameter_sets ?? "-"} parameter sets and ${v.conditions_screened ?? "-"} conditions were examined on history before the rules were fixed. The more that is tried, the more likely something looks good by chance.` })),
      sec("What the “Make a plan” page does",
        h("p", {}, "It takes an amount, a target for the day and a risk tolerance, sizes the levels above for that money, and checks whether the three fit together. It forecasts nothing new. “Best case” means every target of a rule is reached; the chances shown are how often that rule's past trades did at least that well, multiplied by how often it triggered on similar days."),
        h("p", {}, b("A plan appearing there is not a recommendation. "), "Most rules shown have lost money on average after costs, and the page says so on each one. When the three numbers cannot fit, it says why and shows what the estimates do support.")),
      sec("Costs that are always included",
        ul(`Brokerage: ${(c.brokerage.pct_per_order * 100).toFixed(2)}% per order, capped at ₹${c.brokerage.max_per_order}, on both legs.`,
           `Securities Transaction Tax ${(c.stt_sell * 100).toFixed(3)}% on the sell side, exchange charge ${(c.exchange_txn * 100).toFixed(5)}%, stamp duty ${(c.stamp_duty_buy * 100).toFixed(3)}% on the buy side, GST ${(c.gst * 100).toFixed(0)}% on brokerage and fees.`,
           `Slippage of ${c.slippage.tiers.map((t) => (t.per_side * 100).toFixed(2) + "%").join(" / ")} per side by liquidity tier, and ${c.slippage.stop_exit_multiplier} times that on stop exits.`,
           c.verified ? "These rates have been checked against a real contract note." : "These are typical discount-broker rates and have not yet been checked against a real contract note.")),
      sec("What this tool does not know",
        ul("Results dates, corporate announcements and news. A plan can be made the evening before a result.",
           "Futures and options positioning, circuit limits, and the pre-open auction.",
           "Anything that happens while the market is open. Outcomes are worked out afterwards from 5-minute bars, or from the daily bar with the stop assumed to come first.",
           "Past survivorship: the backtest uses today's Nifty 50 members, which flatters history.")),
      q ? sec("Data and its quality",
        ul(`${fmt.int(q.sessions_archived)} official NSE sessions from ${fmtDate(q.first_session)} to ${fmtDate(q.last_session)}, cross-checked every day against a second source.`,
           `The two sources agree within 0.1% on ${fmt.num(q.cross_check.agree_within_0_1_pct, 1)}% of ${fmt.int(q.cross_check.sessions_compared)} comparisons. ${fmt.int(q.cross_check.disagreements_over_0_5_pct)} days disagree by more than 0.5%; the official price is used.`,
           `Repairs made: ${Object.entries(q.repairs).map(([k, n]) => `${k.replaceAll("_", " ")} ${n}`).join(", ") || "none"}.`),
        h("p", { class: "muted small", text: "Sources: official NSE end-of-day files and Yahoo Finance's chart data. Only derived analytics are published here." })) : null,
      sec("Please read",
        h("p", {}, b("This is not investment advice, a research report, or a recommendation to buy or sell any security. "), "It is an educational decision-support tool. Trading carries a real risk of loss, and intraday trading loses money for most people who try it. Past behaviour does not guarantee future results. Decide for yourself, and consider speaking to a SEBI-registered adviser."))));
  reveal(root);
}
