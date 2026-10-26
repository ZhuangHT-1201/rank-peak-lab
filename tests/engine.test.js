"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../js/engine");

test("parses bilingual CSV headers, results, and quoted text", () => {
  const csv = [
    "start_time,end_time,result,mode,hero,role,delta,note",
    "2026-10-01 20:00,2026-10-01 20:20,win,Ranked,Sun Shangxiang,Marksman,1,\"first win, good form\"",
    "2026-10-01 20:25,2026-10-01 20:50,loss,Ranked,Gongsun Li,Marksman,-1,",
  ].join("\n");
  const parsed = engine.parseMatchesCsv(csv);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.matches.length, 2);
  assert.equal(parsed.matches[0].result, "win");
  assert.equal(parsed.matches[0].note, "first win, good form");
  assert.equal(parsed.matches[1].starDelta, -1);
});

test("normalizes Ranked and Peak aliases", () => {
  assert.equal(engine.normalizeMode("Ranked").key, "ranked");
  assert.equal(engine.normalizeMode("排位赛").key, "ranked");
  assert.equal(engine.normalizeMode("Peak").key, "peak");
  assert.equal(engine.normalizeMode("巅峰").key, "peak");
  const match = engine.normalizeMatch({
    startAt: "2026-10-01 20:00",
    result: "win",
    mode: "巅峰",
  });
  assert.equal(match.mode, "Peak");
  assert.equal(match.modeType, "peak");
});

test("skips invalid rows with an indexed error", () => {
  const csv = ["start_time,result", "2026-10-01 20:00,win", "invalid,loss"].join("\n");
  const parsed = engine.parseMatchesCsv(csv);
  assert.equal(parsed.matches.length, 1);
  assert.equal(parsed.skipped, 1);
  assert.match(parsed.errors[0], /Row 3/);
});

test("splits sessions and tracks loss streaks", () => {
  const rows = engine.deriveMatches(
    [
      { startAt: "2026-10-01 20:00", endAt: "2026-10-01 20:20", result: "win" },
      { startAt: "2026-10-01 20:25", endAt: "2026-10-01 20:45", result: "loss" },
      { startAt: "2026-10-01 20:50", endAt: "2026-10-01 21:10", result: "loss" },
      { startAt: "2026-10-01 23:00", endAt: "2026-10-01 23:20", result: "win" },
    ],
    { sessionBreakMin: 90 }
  );
  assert.deepEqual(rows.map((row) => row.sessionMatchNo), [1, 2, 3, 1]);
  assert.equal(rows[2].sessionLossStreak, 2);
  assert.equal(rows[3].sessionId, 1);
  assert.equal(rows[3].preLossStreak, 0);
  assert.equal(rows[2].previousOutcome, "loss");
});

test("reports rates, sample sizes, and Wilson intervals", () => {
  const rows = engine.deriveMatches(
    [
      { startAt: "2026-10-01 20:00", endAt: "2026-10-01 20:20", result: "win" },
      { startAt: "2026-10-01 20:25", endAt: "2026-10-01 20:45", result: "loss" },
      { startAt: "2026-10-01 20:50", endAt: "2026-10-01 21:10", result: "win" },
    ],
    {}
  );
  const analysis = engine.analyze(rows, {}, new Date("2026-10-01T22:00:00"));
  const afterLoss = analysis.groups.afterResult.find((group) => group.key === "loss");
  assert.equal(afterLoss.n, 1);
  assert.equal(afterLoss.wins, 1);
  assert.ok(afterLoss.lower >= 0 && afterLoss.upper <= 1);
  assert.ok(afterLoss.upper > afterLoss.lower);
});

test("generates valid demo predictions and outcomes", () => {
  const now = new Date("2026-10-26T20:00:00+08:00");
  const matches = engine.createDemoMatches(now, 240);
  assert.ok(matches.length >= 100);
  const analysis = engine.analyze(matches, engine.DEFAULT_CONFIG, now);
  assert.equal(analysis.rows.length, matches.length);
  assert.ok(analysis.decision.now.probability > 0);
  assert.ok(analysis.decision.now.probability < 1);
  assert.ok(analysis.decision.now.lower <= analysis.decision.now.probability);
  assert.ok(analysis.decision.now.upper >= analysis.decision.now.probability);
  assert.ok(analysis.forecast.length > 20);
  const total = analysis.decision.plan.distribution.reduce(
    (sum, row) => sum + row.probability,
    0
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("keeps Ranked and Peak samples separate", () => {
  const now = new Date("2026-10-26T20:00:00+08:00");
  const matches = engine.createDemoMatches(now, 240);
  const ranked = matches.filter((match) => engine.modeTypeOf(match.mode) === "ranked");
  const peak = matches.filter((match) => engine.modeTypeOf(match.mode) === "peak");
  assert.ok(ranked.length > 30);
  assert.ok(peak.length > 30);
  const rankedAnalysis = engine.analyze(ranked, { winPoints: 1, lossPoints: 1 }, now);
  const peakAnalysis = engine.analyze(peak, { winPoints: 20, lossPoints: 20 }, now);
  assert.equal(rankedAnalysis.rows.length, ranked.length);
  assert.equal(peakAnalysis.rows.length, peak.length);
  assert.equal(rankedAnalysis.rows.some((row) => row.mode === "Peak"), false);
  assert.equal(peakAnalysis.rows.some((row) => row.mode === "Ranked"), false);
});

test("returns a neutral estimate without history", () => {
  const analysis = engine.analyze([], {}, new Date("2026-10-26T20:00:00"));
  assert.equal(analysis.summary.n, 0);
  assert.ok(Math.abs(analysis.decision.now.probability - 0.5) < 1e-9);
  assert.ok(Number.isFinite(analysis.decision.expectedNext));
});

test("round-trips key CSV fields", () => {
  const original = [
    {
      startAt: "2026-10-01 20:00",
      endAt: "2026-10-01 20:21",
      result: "win",
      mode: "Ranked",
      hero: "Da Qiao",
      role: "Support",
      starDelta: 1,
      note: 'note with "quotes", and a comma',
    },
  ];
  const parsed = engine.parseMatchesCsv(engine.toCsv(original));
  assert.equal(parsed.matches.length, 1);
  assert.equal(parsed.matches[0].result, "win");
  assert.equal(parsed.matches[0].hero, "Da Qiao");
  assert.equal(parsed.matches[0].note, original[0].note);
});

test("computes the expected net value of a plan", () => {
  const plan = engine.planOutcome(0.55, { winPoints: 1, lossPoints: 1 }, 10);
  assert.equal(plan.games, 10);
  assert.ok(Math.abs(plan.expectedNet - 1) < 1e-9);
  assert.ok(plan.probabilityPositive > 0.5 && plan.probabilityPositive < 1);
});

test("activates a validated state model on a strong signal", () => {
  let value = 12345;
  const random = () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
  let startAt = new Date("2026-08-01T19:00:00").getTime();
  let previous = "win";
  const rows = [];
  for (let index = 0; index < 320; index += 1) {
    const probability = previous === "win" ? 0.78 : 0.3;
    const result = random() < probability ? "win" : "loss";
    rows.push({ startAt, endAt: startAt + 20 * 60000, result });
    startAt += 27 * 60000;
    previous = result;
  }
  const analysis = engine.analyze(rows, {}, new Date("2026-08-09T10:00:00"));
  assert.equal(analysis.model.status, "active");
  assert.ok(analysis.model.weight > 0);
  assert.ok(analysis.model.validation.adaptiveBrier < analysis.model.validation.baselineBrier);
});
