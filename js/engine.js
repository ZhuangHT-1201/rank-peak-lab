(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.MatchEngine = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "1.1.0";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MODE_DEFINITIONS = Object.freeze({
    ranked: { key: "ranked", label: "Ranked", unit: "stars" },
    peak: { key: "peak", label: "Peak", unit: "points" },
    other: { key: "other", label: "Other", unit: "points" },
  });

  const DEFAULT_CONFIG = Object.freeze({
    sessionBreakMin: 90,
    defaultMatchMin: 18,
    priorMatches: 20,
    priorWinRate: 0.5,
    riskMode: "balanced",
    winPoints: 1,
    lossPoints: 1,
    stopLossStreak: 2,
    sessionCap: 5,
    cooldownMin: 45,
    activeStartHour: 9,
    activeEndHour: 23,
    minModelRows: 120,
  });

  const TIME_BUCKETS = [
    { key: "late", label: "00:00–06:00", start: 0, end: 6 },
    { key: "morning", label: "06:00–12:00", start: 6, end: 12 },
    { key: "afternoon", label: "12:00–18:00", start: 12, end: 18 },
    { key: "evening", label: "18:00–24:00", start: 18, end: 24 },
  ];

  const GAP_BUCKETS = [
    { key: "0-10", label: "10 min or less", start: 0, end: 10 },
    { key: "10-30", label: "10–30 min", start: 10, end: 30 },
    { key: "30-60", label: "30–60 min", start: 30, end: 60 },
    { key: "60-120", label: "1–2 hr", start: 60, end: 120 },
    { key: "120-240", label: "2–4 hr", start: 120, end: 240 },
    { key: "240-720", label: "4–12 hr", start: 240, end: 720 },
    { key: "720-plus", label: "12 hr or more", start: 720, end: Infinity },
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function sigmoid(value) {
    if (value >= 0) {
      const exp = Math.exp(-value);
      return 1 / (1 + exp);
    }
    const exp = Math.exp(value);
    return exp / (1 + exp);
  }

  function logit(probability) {
    const safe = clamp(probability, 0.0001, 0.9999);
    return Math.log(safe / (1 - safe));
  }

  function normalizeConfig(input) {
    const source = input && typeof input === "object" ? input : {};
    const config = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
        if (key === "riskMode") {
          config[key] = ["conservative", "balanced", "aggressive"].includes(source[key])
            ? source[key]
            : DEFAULT_CONFIG[key];
        } else {
          const number = Number(source[key]);
          if (Number.isFinite(number)) {
            config[key] = number;
          }
        }
      }
    }
    config.sessionBreakMin = clamp(config.sessionBreakMin, 30, 720);
    config.defaultMatchMin = clamp(config.defaultMatchMin, 5, 120);
    config.priorMatches = clamp(config.priorMatches, 1, 200);
    config.priorWinRate = clamp(config.priorWinRate, 0.05, 0.95);
    config.winPoints = clamp(Math.abs(config.winPoints), 0, 20);
    config.lossPoints = clamp(Math.abs(config.lossPoints), 0, 20);
    config.stopLossStreak = clamp(Math.round(config.stopLossStreak), 1, 10);
    config.sessionCap = clamp(Math.round(config.sessionCap), 1, 30);
    config.cooldownMin = clamp(config.cooldownMin, 0, 240);
    config.activeStartHour = clamp(Math.round(config.activeStartHour), 0, 23);
    config.activeEndHour = clamp(Math.round(config.activeEndHour), 1, 24);
    config.minModelRows = clamp(Math.round(config.minModelRows), 60, 1000);
    return config;
  }

  function parseDateTime(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.getTime();
    }
    if (isFiniteNumber(value) && value > 0) {
      if (value > 1e11) {
        return value;
      }
      if (value > 20000 && value < 90000) {
        return Math.round(Date.UTC(1899, 11, 30) + value * DAY_MS);
      }
    }

    const text = String(value == null ? "" : value).trim();
    if (!text) {
      return null;
    }
    if (/^\d{5}(?:\.\d+)?$/.test(text)) {
      return Math.round(Date.UTC(1899, 11, 30) + Number(text) * DAY_MS);
    }

    const normalized = text
      .replace(/[年/.]/g, "-")
      .replace(/月/g, "-")
      .replace(/日/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const match = normalized.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
    );
    if (match) {
      const milliseconds = match[7] ? Number(`0.${match[7]}`) * 1000 : 0;
      return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4] || 0),
        Number(match[5] || 0),
        Number(match[6] || 0),
        milliseconds
      ).getTime();
    }

    const parsed = new Date(text).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeResult(value) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (["胜", "胜利", "赢", "win", "won", "true", "1", "yes", "y"].includes(text)) {
      return "win";
    }
    if (["负", "失败", "输", "loss", "lost", "false", "0", "no", "n"].includes(text)) {
      return "loss";
    }
    return null;
  }

  function normalizeMode(value) {
    const text = String(value == null ? "" : value).trim();
    const lower = text.toLowerCase();
    if (/巅峰|peak/.test(lower)) {
      return MODE_DEFINITIONS.peak;
    }
    if (/排位|ranked|\brank\b/.test(lower) || !text) {
      return MODE_DEFINITIONS.ranked;
    }
    return {
      key: "other",
      label: text,
      unit: "points",
    };
  }

  function modeTypeOf(value) {
    return normalizeMode(value).key;
  }

  function normalizeMatch(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid match record");
    }
    const startAt = parseDateTime(raw.startAt ?? raw.startTime ?? raw.time ?? raw.datetime);
    if (!startAt) {
      throw new Error("Missing or invalid start time");
    }
    const result = normalizeResult(raw.result ?? raw.outcome ?? raw.win);
    if (!result) {
      throw new Error("Result must be win/loss, 1/0, or 胜/负");
    }
    const endAtRaw = parseDateTime(raw.endAt ?? raw.endTime);
    const endAt = endAtRaw && endAtRaw > startAt ? endAtRaw : null;
    const modeDefinition = normalizeMode(raw.mode ?? raw.modeType ?? "Ranked");
    const mode = modeDefinition.label;
    const hero = String(raw.hero || "").trim();
    const role = String(raw.role || raw.position || "").trim();
    const note = String(raw.note || "").trim();
    let starDelta = raw.starDelta === "" || raw.starDelta == null ? null : Number(raw.starDelta);
    if (!Number.isFinite(starDelta)) {
      starDelta = null;
    }
    const idBase = `${startAt}-${result}-${mode}-${hero}-${endAt || ""}`.replace(/\s+/g, "_");
    return {
      id: String(raw.id || `m_${idBase}`),
      startAt,
      endAt,
      result,
      mode,
      modeType: modeDefinition.key,
      hero,
      role,
      starDelta,
      note,
      source: String(raw.source || ""),
    };
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const input = String(text).replace(/^\uFEFF/, "");

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (quoted) {
        if (char === '"' && input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        row.push(cell);
        cell = "";
      } else if (char === "\n") {
        row.push(cell.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
    return rows;
  }

  function detectDelimiter(text) {
    const firstLine = String(text)
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .find((line) => line.trim());
    if (!firstLine) {
      return ",";
    }
    const counts = [
      { value: "\t", count: (firstLine.match(/\t/g) || []).length },
      { value: ",", count: (firstLine.match(/,/g) || []).length },
      { value: ";", count: (firstLine.match(/;/g) || []).length },
    ];
    counts.sort((a, b) => b.count - a.count);
    return counts[0].count > 0 ? counts[0].value : ",";
  }

  function normalizeHeader(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_\-—–:：()（）]/g, "");
  }

  function indexOfHeader(headers, aliases) {
    const normalizedAliases = new Set(aliases.map(normalizeHeader));
    return headers.findIndex((header) => normalizedAliases.has(normalizeHeader(header)));
  }

  function parseMatchesCsv(text) {
    const source = String(text || "").trim();
    if (!source) {
      return { matches: [], errors: ["No data to import"], skipped: 0 };
    }
    const delimiter = detectDelimiter(source);
    const rows = parseDelimited(source, delimiter).filter((row) =>
      row.some((cell) => String(cell).trim())
    );
    if (rows.length < 2) {
      return { matches: [], errors: ["A header and at least one match are required"], skipped: 0 };
    }

    const headers = rows.shift().map((header) => header.trim());
    const startIndex = indexOfHeader(headers, [
      "开始时间",
      "对局时间",
      "比赛时间",
      "日期时间",
      "datetime",
      "starttime",
      "gametime",
    ]);
    const dateIndex = indexOfHeader(headers, ["日期", "date"]);
    const timeIndex = indexOfHeader(headers, ["时间", "time"]);
    const endIndex = indexOfHeader(headers, ["结束时间", "endtime"]);
    const resultIndex = indexOfHeader(headers, ["结果", "胜负", "输赢", "result", "winloss"]);
    const modeIndex = indexOfHeader(headers, ["模式", "玩法", "mode"]);
    const heroIndex = indexOfHeader(headers, ["英雄", "hero"]);
    const roleIndex = indexOfHeader(headers, ["位置", "分路", "role", "position"]);
    const starsIndex = indexOfHeader(headers, [
      "星变化",
      "积分变化",
      "净胜星",
      "stardelta",
      "delta",
      "points",
    ]);
    const noteIndex = indexOfHeader(headers, ["备注", "note"]);
    const fallbackTimeIndex = startIndex < 0 && dateIndex < 0 && timeIndex >= 0 ? timeIndex : -1;

    if (startIndex < 0 && dateIndex < 0 && fallbackTimeIndex < 0) {
      return {
        matches: [],
        errors: ["Missing time column. Use start_time or date + time."],
        skipped: 0,
      };
    }
    if (resultIndex < 0) {
      return { matches: [], errors: ["Missing result column."], skipped: 0 };
    }

    const matches = [];
    const errors = [];
    let skipped = 0;
    rows.forEach((row, rowIndex) => {
      if (!row.some((cell) => String(cell).trim())) {
        return;
      }
      let startText = startIndex >= 0 ? row[startIndex] : "";
      if (!startText && dateIndex >= 0) {
        startText = `${row[dateIndex] || ""} ${timeIndex >= 0 ? row[timeIndex] || "" : ""}`.trim();
      }
      if (!startText && fallbackTimeIndex >= 0) {
        startText = row[fallbackTimeIndex];
      }
      try {
        matches.push(
          normalizeMatch({
            startAt: startText,
            endAt: endIndex >= 0 ? row[endIndex] : "",
            result: row[resultIndex],
            mode: modeIndex >= 0 ? row[modeIndex] : "",
            hero: heroIndex >= 0 ? row[heroIndex] : "",
            role: roleIndex >= 0 ? row[roleIndex] : "",
            starDelta: starsIndex >= 0 ? row[starsIndex] : "",
            note: noteIndex >= 0 ? row[noteIndex] : "",
            source: "import",
          })
        );
      } catch (error) {
        skipped += 1;
        errors.push(`Row ${rowIndex + 2}: ${error.message}`);
      }
    });

    return { matches, errors, skipped };
  }

  function matchKey(match) {
    const normalized = normalizeMatch(match);
    return [
      normalized.startAt,
      normalized.endAt || "",
      normalized.result,
      normalized.mode,
      normalized.hero,
    ].join("|");
  }

  function mergeMatches(existing, incoming) {
    const map = new Map();
    for (const match of [...(existing || []), ...(incoming || [])]) {
      try {
        map.set(matchKey(match), normalizeMatch(match));
      } catch (_) {
      }
    }
    return [...map.values()].sort((a, b) => a.startAt - b.startAt);
  }

  function timeBucket(hour) {
    return TIME_BUCKETS.find((bucket) => hour >= bucket.start && hour < bucket.end) || TIME_BUCKETS[0];
  }

  function gapBucket(minutes) {
    if (!Number.isFinite(minutes)) {
      return null;
    }
    return (
      GAP_BUCKETS.find(
        (bucket) => minutes >= bucket.start && (minutes < bucket.end || bucket.end === Infinity)
      ) || GAP_BUCKETS[GAP_BUCKETS.length - 1]
    );
  }

  function deriveMatches(input, configInput) {
    const config = normalizeConfig(configInput);
    const normalized = (input || [])
      .map((match) => {
        try {
          return normalizeMatch(match);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.startAt - b.startAt);

    let previous = null;
    let sessionId = -1;
    let sessionMatchNo = 0;
    let sessionWinStreak = 0;
    let sessionLossStreak = 0;

    return normalized.map((match) => {
      const endAt = match.endAt || match.startAt + config.defaultMatchMin * 60 * 1000;
      const gapMin = previous ? Math.max(0, (match.startAt - previous.endAt) / 60000) : null;
      const newSession =
        !previous || (Number.isFinite(gapMin) && gapMin >= config.sessionBreakMin);

      if (newSession) {
        sessionId += 1;
        sessionMatchNo = 0;
        sessionWinStreak = 0;
        sessionLossStreak = 0;
      }
      sessionMatchNo += 1;

      const preWinStreak = sessionWinStreak;
      const preLossStreak = sessionLossStreak;
      if (match.result === "win") {
        sessionWinStreak += 1;
        sessionLossStreak = 0;
      } else {
        sessionLossStreak += 1;
        sessionWinStreak = 0;
      }

      const date = new Date(match.startAt);
      const hour = date.getHours();
      const starDelta =
        match.starDelta == null
          ? match.result === "win"
            ? config.winPoints
            : -config.lossPoints
          : match.starDelta;
      const row = {
        ...match,
        endAt,
        durationMin: Math.max(0, (endAt - match.startAt) / 60000),
        gapMin,
        newSession,
        sessionId,
        sessionMatchNo,
        sessionWinStreak,
        sessionLossStreak,
        preWinStreak,
        preLossStreak,
        previousOutcome: newSession || !previous ? null : previous.result,
        starDelta,
        hour,
        weekday: date.getDay(),
        timeBucket: timeBucket(hour).key,
      };
      previous = row;
      return row;
    });
  }

  function wilsonInterval(wins, total, z) {
    const safeTotal = Math.max(0, total || 0);
    const safeWins = clamp(wins || 0, 0, safeTotal);
    if (safeTotal === 0) {
      return { lower: 0, upper: 1, center: 0.5 };
    }
    const zValue = z || 1.96;
    const p = safeWins / safeTotal;
    const z2 = zValue * zValue;
    const denominator = 1 + z2 / safeTotal;
    const center = (p + z2 / (2 * safeTotal)) / denominator;
    const margin =
      (zValue *
        Math.sqrt((p * (1 - p) + z2 / (4 * safeTotal)) / safeTotal)) /
      denominator;
    return {
      lower: clamp(center - margin, 0, 1),
      upper: clamp(center + margin, 0, 1),
      center: clamp(center, 0, 1),
    };
  }

  function smoothedRate(wins, total, configInput, strength) {
    const config = normalizeConfig(configInput);
    const priorStrength = Number.isFinite(strength) ? strength : config.priorMatches;
    return (
      (wins + config.priorWinRate * priorStrength) /
      (Math.max(0, total) + priorStrength)
    );
  }

  function groupStatistics(rows, keySelector, labelSelector, configInput, sortOrder) {
    const groups = new Map();
    for (const row of rows) {
      const key = keySelector(row);
      if (key == null) {
        continue;
      }
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: labelSelector(row, key),
          wins: 0,
          n: 0,
          stars: 0,
        });
      }
      const group = groups.get(key);
      group.n += 1;
      group.wins += row.result === "win" ? 1 : 0;
      group.stars += row.starDelta || 0;
    }

    const result = [...groups.values()].map((group) => {
      const interval = wilsonInterval(group.wins, group.n);
      return {
        ...group,
        rate: group.n ? group.wins / group.n : 0,
        smoothed: smoothedRate(group.wins, group.n, configInput, 10),
        lower: interval.lower,
        upper: interval.upper,
        lowSample: group.n < 10,
      };
    });

    if (typeof sortOrder === "function") {
      result.sort(sortOrder);
    } else {
      result.sort((a, b) => {
        if (a.n !== b.n) {
          return b.n - a.n;
        }
        return String(a.label).localeCompare(String(b.label), "zh-CN");
      });
    }
    return result;
  }

  function buildGroups(rows, config) {
    const gapOrder = new Map(GAP_BUCKETS.map((bucket, index) => [bucket.key, index]));
    const timeOrder = new Map(TIME_BUCKETS.map((bucket, index) => [bucket.key, index]));
    const afterRows = rows.filter((row) => row.previousOutcome);
    return {
      afterResult: groupStatistics(
        afterRows,
        (row) => row.previousOutcome,
        (row) => (row.previousOutcome === "win" ? "After win" : "After loss"),
        config,
        (a, b) => (a.key === "win" ? -1 : b.key === "win" ? 1 : 0)
      ),
      streak: groupStatistics(
        afterRows,
        (row) => {
          if (row.previousOutcome === "win") {
            return row.preWinStreak >= 2 ? "win2" : "win1";
          }
          return row.preLossStreak >= 2 ? "loss2" : "loss1";
        },
        (_row, key) =>
          ({ win1: "After win", win2: "Win streak 2+", loss1: "After loss", loss2: "Loss streak 2+" })[
            key
          ],
        config,
        (a, b) =>
          ["win1", "win2", "loss1", "loss2"].indexOf(a.key) -
          ["win1", "win2", "loss1", "loss2"].indexOf(b.key)
      ),
      gap: groupStatistics(
        rows.filter((row) => Number.isFinite(row.gapMin) && gapBucket(row.gapMin)),
        (row) => gapBucket(row.gapMin).key,
        (row) => gapBucket(row.gapMin).label,
        config,
        (a, b) => gapOrder.get(a.key) - gapOrder.get(b.key)
      ),
      sessionPosition: groupStatistics(
        rows,
        (row) => Math.min(row.sessionMatchNo, 6),
        (_row, key) => (key === 6 ? "Match 6+" : `Match ${key}`),
        config,
        (a, b) => a.key - b.key
      ),
      time: groupStatistics(
        rows,
        (row) => row.timeBucket,
        (row) => timeBucket(row.hour).label,
        config,
        (a, b) => timeOrder.get(a.key) - timeOrder.get(b.key)
      ),
      weekday: groupStatistics(
        rows,
        (row) => row.weekday,
        (row) =>
          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][row.weekday],
        config,
        (a, b) => a.key - b.key
      ),
    };
  }

  function summarize(rows) {
    const n = rows.length;
    const wins = rows.reduce((sum, row) => sum + (row.result === "win" ? 1 : 0), 0);
    const stars = rows.reduce((sum, row) => sum + (row.starDelta || 0), 0);
    const recent = rows.slice(-20);
    const recentWins = recent.reduce(
      (sum, row) => sum + (row.result === "win" ? 1 : 0),
      0
    );
    const interval = wilsonInterval(wins, n);
    const sessionIds = new Set(rows.map((row) => row.sessionId));
    return {
      n,
      wins,
      losses: n - wins,
      rate: n ? wins / n : 0,
      lower: interval.lower,
      upper: interval.upper,
      stars,
      starsPerMatch: n ? stars / n : 0,
      recentN: recent.length,
      recentRate: recent.length ? recentWins / recent.length : 0,
      sessions: sessionIds.size,
    };
  }

  function makeFeatures(previousOutcome, winStreak, lossStreak, sessionMatchNo, gapMin, startAt) {
    const date = new Date(startAt);
    const hour = date.getHours();
    const direction =
      previousOutcome === "win" ? 1 : previousOutcome === "loss" ? -1 : 0;
    const streak =
      previousOutcome === "win"
        ? Math.min(winStreak || 1, 4)
        : previousOutcome === "loss"
          ? -Math.min(lossStreak || 1, 4)
          : 0;
    const sessionPosition = Math.max(1, Number(sessionMatchNo) || 1);
    const gap = clamp(Number.isFinite(gapMin) ? gapMin : 720, 0, 10080);
    return [
      direction,
      streak / 4,
      Math.log1p(sessionPosition - 1) / Math.log(10),
      Math.log1p(gap),
      hour < 6 ? 1 : 0,
      hour >= 18 ? 1 : 0,
      hour >= 12 && hour < 18 ? 1 : 0,
      date.getDay() === 0 || date.getDay() === 6 ? 1 : 0,
    ];
  }

  function buildPredictiveRows(rows) {
    return rows
      .filter((row, index) => index > 0)
      .map((row) => ({
        at: row.startAt,
        y: row.result === "win" ? 1 : 0,
        features: makeFeatures(
          row.previousOutcome,
          row.preWinStreak,
          row.preLossStreak,
          row.sessionMatchNo,
          row.gapMin,
          row.startAt
        ),
      }));
  }

  function trainLogistic(rows, config, lambda, epochs) {
    if (!rows.length) {
      return null;
    }
    const featureCount = rows[0].features.length;
    const means = Array(featureCount).fill(0);
    const scales = Array(featureCount).fill(0);
    for (const row of rows) {
      for (let j = 0; j < featureCount; j += 1) {
        means[j] += row.features[j];
      }
    }
    for (let j = 0; j < featureCount; j += 1) {
      means[j] /= rows.length;
    }
    for (const row of rows) {
      for (let j = 0; j < featureCount; j += 1) {
        const delta = row.features[j] - means[j];
        scales[j] += delta * delta;
      }
    }
    for (let j = 0; j < featureCount; j += 1) {
      scales[j] = Math.sqrt(scales[j] / rows.length) || 1;
    }

    const x = rows.map((row) =>
      row.features.map((value, index) => (value - means[index]) / scales[index])
    );
    const y = rows.map((row) => row.y);
    const baseRate = smoothedRate(
      y.reduce((sum, value) => sum + value, 0),
      y.length,
      config
    );
    const weights = Array(featureCount).fill(0);
    let bias = logit(baseRate);
    const regularization = Number.isFinite(lambda) ? lambda : 0.8;
    const iterations = Number.isFinite(epochs) ? epochs : 1100;
    const learningRate = 0.18;

    for (let epoch = 0; epoch < iterations; epoch += 1) {
      const gradient = Array(featureCount).fill(0);
      let biasGradient = 0;
      for (let i = 0; i < x.length; i += 1) {
        let linear = bias;
        for (let j = 0; j < featureCount; j += 1) {
          linear += weights[j] * x[i][j];
        }
        const error = sigmoid(linear) - y[i];
        biasGradient += error;
        for (let j = 0; j < featureCount; j += 1) {
          gradient[j] += error * x[i][j];
        }
      }
      bias -= learningRate * (biasGradient / x.length);
      for (let j = 0; j < featureCount; j += 1) {
        const l2 = (regularization * weights[j]) / x.length;
        weights[j] -= learningRate * (gradient[j] / x.length + l2);
      }
    }

    return {
      means,
      scales,
      weights,
      bias,
      baseRate,
      samples: rows.length,
      version: "ridge-logit-v1",
      predict(features) {
        let linear = bias;
        for (let index = 0; index < featureCount; index += 1) {
          linear += weights[index] * ((features[index] - means[index]) / scales[index]);
        }
        return sigmoid(linear);
      },
    };
  }

  function logLoss(probabilities, labels) {
    if (!probabilities.length) {
      return 0;
    }
    let total = 0;
    for (let index = 0; index < probabilities.length; index += 1) {
      const p = clamp(probabilities[index], 1e-6, 1 - 1e-6);
      total += labels[index] === 1 ? -Math.log(p) : -Math.log(1 - p);
    }
    return total / probabilities.length;
  }

  function brierScore(probabilities, labels) {
    if (!probabilities.length) {
      return 0;
    }
    return (
      probabilities.reduce((sum, p, index) => sum + (p - labels[index]) ** 2, 0) /
      probabilities.length
    );
  }

  function trainAndValidate(rows, configInput) {
    const config = normalizeConfig(configInput);
    const predictive = buildPredictiveRows(rows);
    const empty = {
      enabled: false,
      weight: 0,
      status: "insufficient",
      rows: predictive.length,
      model: null,
      validation: null,
    };
    if (predictive.length < Math.min(60, config.minModelRows)) {
      return empty;
    }

    const splitIndex = Math.floor(predictive.length * 0.7);
    const trainRows = predictive.slice(0, splitIndex);
    const validationRows = predictive.slice(splitIndex);
    if (trainRows.length < 40 || validationRows.length < 20) {
      return empty;
    }

    const validationModel = trainLogistic(trainRows, config, 0.8, 900);
    const labels = validationRows.map((row) => row.y);
    const trainWins = trainRows.reduce((sum, row) => sum + row.y, 0);
    const baselineProbability = smoothedRate(trainWins, trainRows.length, config);
    const baselineProbabilities = labels.map(() => baselineProbability);
    const adaptiveProbabilities = validationRows.map((row) =>
      validationModel.predict(row.features)
    );
    const baselineBrier = brierScore(baselineProbabilities, labels);
    const adaptiveBrier = brierScore(adaptiveProbabilities, labels);
    const baselineLogLoss = logLoss(baselineProbabilities, labels);
    const adaptiveLogLoss = logLoss(adaptiveProbabilities, labels);
    const improvement = baselineBrier - adaptiveBrier;
    const accepted =
      predictive.length >= config.minModelRows &&
      improvement > 0.002 &&
      adaptiveLogLoss <= baselineLogLoss + 0.005;
    const sampleFactor = clamp((predictive.length - config.minModelRows) / 180, 0, 1);
    const effectFactor = clamp((improvement - 0.002) / 0.03, 0, 1);
    const weight = accepted
      ? clamp(0.65 * sampleFactor * (0.35 + 0.65 * effectFactor), 0, 0.65)
      : 0;
    const validation = {
      trainRows: trainRows.length,
      validationRows: validationRows.length,
      baselineProbability,
      baselineBrier,
      adaptiveBrier,
      baselineLogLoss,
      adaptiveLogLoss,
      improvement,
      accepted,
    };

    if (!accepted || weight <= 0) {
      return {
        ...empty,
        status: accepted ? "unstable" : "not_better",
        model: null,
        validation,
      };
    }

    return {
      enabled: true,
      weight,
      status: "active",
      rows: predictive.length,
      model: trainLogistic(predictive, config, 0.8, 1200),
      validation,
    };
  }

  function breakEvenProbability(configInput) {
    const config = normalizeConfig(configInput);
    const total = config.winPoints + config.lossPoints;
    return total > 0 ? config.lossPoints / total : 0;
  }

  function riskBuffer(configInput) {
    const config = normalizeConfig(configInput);
    if (config.riskMode === "conservative") {
      return 0.035;
    }
    if (config.riskMode === "aggressive") {
      return 0.005;
    }
    return 0.018;
  }

  function predictionInterval(probability, sampleSize, configInput, modelWeight) {
    const config = normalizeConfig(configInput);
    const effectiveN = config.priorMatches + Math.max(0, sampleSize || 0);
    const binomialMargin =
      1.96 * Math.sqrt((probability * (1 - probability)) / Math.max(effectiveN, 1));
    const modelMargin = modelWeight ? 0.008 + (1 - modelWeight) * 0.018 : 0.018;
    const margin = binomialMargin + modelMargin;
    return {
      lower: clamp(probability - margin, 0.001, 0.999),
      upper: clamp(probability + margin, 0.001, 0.999),
      margin,
    };
  }

  function predictAt(rows, configInput, modelState, startAt) {
    const config = normalizeConfig(configInput);
    const last = rows[rows.length - 1] || null;
    const gapMin = last ? Math.max(0, (startAt - last.endAt) / 60000) : Infinity;
    const newSession = !last || gapMin >= config.sessionBreakMin;
    const previousOutcome = newSession || !last ? null : last.result;
    const winStreak = newSession || !last ? 0 : last.sessionWinStreak;
    const lossStreak = newSession || !last ? 0 : last.sessionLossStreak;
    const sessionMatchNo = newSession || !last ? 1 : last.sessionMatchNo + 1;
    const features = makeFeatures(
      previousOutcome,
      winStreak,
      lossStreak,
      sessionMatchNo,
      gapMin,
      startAt
    );
    const baseWins = rows.reduce((sum, row) => sum + (row.result === "win" ? 1 : 0), 0);
    const baseline = smoothedRate(baseWins, rows.length, config);
    let adaptive = baseline;
    if (modelState && modelState.enabled && modelState.model) {
      const modelProbability = modelState.model.predict(features);
      adaptive =
        baseline * (1 - modelState.weight) + modelProbability * modelState.weight;
    }

    const bucket = timeBucket(new Date(startAt).getHours());
    const timeRows = rows.filter((row) => row.timeBucket === bucket.key);
    const timeWins = timeRows.reduce(
      (sum, row) => sum + (row.result === "win" ? 1 : 0),
      0
    );
    const localRate = smoothedRate(timeWins, timeRows.length, config, 20);
    const localWeight =
      timeRows.length >= 6
        ? clamp(timeRows.length / 300, 0, 0.16) * (modelState && modelState.enabled ? 0.65 : 1)
        : 0;
    const probability = clamp(adaptive * (1 - localWeight) + localRate * localWeight, 0.02, 0.98);
    const interval = predictionInterval(
      probability,
      rows.length,
      config,
      modelState ? modelState.weight : 0
    );
    return {
      at: startAt,
      gapMin,
      newSession,
      previousOutcome,
      winStreak,
      lossStreak,
      sessionMatchNo,
      probability,
      lower: interval.lower,
      upper: interval.upper,
      timeBucket: bucket.key,
      timeLabel: bucket.label,
      timeSamples: timeRows.length,
      modelWeight: modelState ? modelState.weight : 0,
    };
  }

  function activeHour(date, config) {
    const hour = date.getHours();
    if (config.activeStartHour < config.activeEndHour) {
      return hour >= config.activeStartHour && hour < config.activeEndHour;
    }
    return hour >= config.activeStartHour || hour < config.activeEndHour;
  }

  function buildForecast(rows, config, modelState, now, hours) {
    const forecast = [];
    const spanHours = Number.isFinite(hours) ? hours : 24;
    for (let minute = 0; minute <= spanHours * 60; minute += 30) {
      const at = now + minute * 60 * 1000;
      const prediction = predictAt(rows, config, modelState, at);
      forecast.push({
        ...prediction,
        active: activeHour(new Date(at), config),
        score:
          prediction.probability -
          (config.riskMode === "conservative"
            ? (prediction.upper - prediction.lower) * 0.45
            : config.riskMode === "balanced"
              ? (prediction.upper - prediction.lower) * 0.2
              : 0),
      });
    }
    return forecast;
  }

  function bestForecast(forecast, filter) {
    const candidates = forecast.filter(filter);
    if (!candidates.length) {
      return null;
    }
    return candidates.reduce((best, candidate) =>
      candidate.score > best.score ? candidate : best
    );
  }

  function forecastWindow(forecast, center) {
    if (!center) {
      return null;
    }
    const centerIndex = forecast.findIndex((row) => row.at === center.at);
    const candidates = [];
    for (let startIndex = 0; startIndex < forecast.length - 3; startIndex += 1) {
      const endIndex = startIndex + 3;
      if (endIndex < centerIndex || startIndex > centerIndex) {
        continue;
      }
      const segment = forecast.slice(startIndex, endIndex + 1);
      if (
        segment.some((row) => !row.active) ||
        segment[segment.length - 1].at - segment[0].at > 90 * 60 * 1000
      ) {
        continue;
      }
      candidates.push({
        startIndex,
        endIndex,
        score: segment.reduce((sum, row) => sum + row.score, 0) / segment.length,
        distance: Math.abs(startIndex - centerIndex) + Math.abs(endIndex - centerIndex),
      });
    }
    let chosen = null;
    if (candidates.length) {
      chosen = candidates.reduce((best, candidate) => {
        if (candidate.score > best.score + 1e-9) {
          return candidate;
        }
        if (Math.abs(candidate.score - best.score) <= 1e-9 && candidate.distance < best.distance) {
          return candidate;
        }
        return best;
      });
    }
    const startIndex = chosen ? chosen.startIndex : Math.max(0, centerIndex);
    const endIndex = chosen
      ? chosen.endIndex
      : Math.min(forecast.length - 1, centerIndex + 1);
    const start = forecast[startIndex].at;
    const end = forecast[endIndex].at + 30 * 60 * 1000;
    return {
      start,
      end,
      peakAt: center.at,
      probability: center.probability,
      lower: center.lower,
      upper: center.upper,
      score: center.score,
    };
  }

  function planOutcome(probability, configInput, games) {
    const config = normalizeConfig(configInput);
    const n = clamp(Math.round(games || 10), 1, 50);
    const totalAtMatch = [];
    for (let wins = 0; wins <= n; wins += 1) {
      const losses = n - wins;
      const choose = factorialLog(n) - factorialLog(wins) - factorialLog(losses);
      const logProbability = choose + wins * Math.log(clamp(probability, 1e-9, 1)) + losses * Math.log(clamp(1 - probability, 1e-9, 1));
      totalAtMatch.push({
        wins,
        probability: Math.exp(logProbability),
        net: wins * config.winPoints - losses * config.lossPoints,
      });
    }
    const normalizer = totalAtMatch.reduce((sum, row) => sum + row.probability, 0) || 1;
    totalAtMatch.forEach((row) => {
      row.probability /= normalizer;
    });
    return {
      games: n,
      expectedNet: totalAtMatch.reduce((sum, row) => sum + row.net * row.probability, 0),
      probabilityPositive: totalAtMatch
        .filter((row) => row.net > 0)
        .reduce((sum, row) => sum + row.probability, 0),
      distribution: totalAtMatch,
    };
  }

  function factorialLog(value) {
    let result = 0;
    for (let number = 2; number <= value; number += 1) {
      result += Math.log(number);
    }
    return result;
  }

  function formatClock(value) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  }

  function formatDayTime(value, now) {
    const date = new Date(value);
    const today = new Date(now);
    const tomorrow = new Date(now + DAY_MS);
    const sameDay = date.toDateString() === today.toDateString();
    const nextDay = date.toDateString() === tomorrow.toDateString();
    if (sameDay) {
      return `Today ${formatClock(value)}`;
    }
    if (nextDay) {
      return `Tomorrow ${formatClock(value)}`;
    }
    return new Intl.DateTimeFormat("en-US", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function buildDecision(rows, config, modelState, forecast, now) {
    const last = rows[rows.length - 1] || null;
    const nowPrediction = predictAt(rows, config, modelState, now);
    const breakEven = breakEvenProbability(config);
    const buffer = riskBuffer(config);
    const threshold = clamp(breakEven + buffer, 0, 1);
    const elapsedMin = last ? Math.max(0, (now - last.endAt) / 60000) : Infinity;
    const sameSession = Boolean(last && elapsedMin < config.sessionBreakMin);
    const playedInSession = sameSession ? last.sessionMatchNo : 0;
    const currentLossStreak = sameSession ? last.sessionLossStreak : 0;
    const currentWinStreak = sameSession ? last.sessionWinStreak : 0;
    const guardReasons = [];
    if (currentLossStreak >= config.stopLossStreak) {
      guardReasons.push(`${currentLossStreak} consecutive losses reached the stop limit.`);
    }
    if (playedInSession >= config.sessionCap) {
      guardReasons.push(`${playedInSession} matches reached the session limit.`);
    }

    const activeForecast = forecast.filter((row) => row.active);
    const requiredCooldown =
      sameSession && last && last.result === "loss" ? config.cooldownMin : 0;
    const futureCandidates = activeForecast.filter(
      (row) => row.at >= now + requiredCooldown * 60000
    );
    const bestFuture =
      bestForecast(futureCandidates, () => true) ||
      bestForecast(activeForecast, (row) => row.at > now) ||
      nowPrediction;
    const minLift = config.riskMode === "conservative" ? 0.025 : 0.012;
    const earliestBetter = futureCandidates.find(
      (row) =>
        row.probability >= threshold &&
        row.probability >= nowPrediction.probability + minLift
    );

    let code;
    let title;
    let summary;
    let center;
    if (guardReasons.length) {
      code = "stop";
      title = "Stop this session";
      summary = "A session limit has been reached.";
      center = bestForecast(
        activeForecast,
        (row) => row.at >= now + DAY_MS
      );
    } else if (nowPrediction.probability >= threshold) {
      code = nowPrediction.lower >= breakEven ? "play" : "cautious";
      title = code === "play" ? "Play next match" : "Play one match";
      summary =
        code === "play"
          ? "The current estimate is above your break-even rate."
          : "The estimate is above break-even, but the confidence interval is not.";
      center = activeForecast.find((row) => row.at >= now) || nowPrediction;
    } else if (earliestBetter || (last && last.result === "loss" && elapsedMin < config.cooldownMin)) {
      code = "wait";
      title = "Wait before playing";
      summary = "The current estimate is below the action threshold.";
      center = earliestBetter || bestFuture;
    } else {
      code = "stop";
      title = "Do not continue";
      summary = "No positive edge is supported by the current data.";
      center = bestFuture;
    }

    let window = forecastWindow(forecast, center);
    if (
      window &&
      code !== "play" &&
      code !== "cautious" &&
      (!center || center.probability < threshold)
    ) {
      window = null;
    }
    const cooldownAt =
      last && sameSession && last.result === "loss" ? now + config.cooldownMin * 60000 : null;
    const expectedNext =
      nowPrediction.probability * config.winPoints -
      (1 - nowPrediction.probability) * config.lossPoints;
    const reasons = [];
    if (!rows.length) {
      reasons.push("No match history. Using a 50% prior.");
    } else {
      reasons.push(
        `Smoothed overall win rate: ${(smoothedRate(
          rows.reduce((sum, row) => sum + (row.result === "win" ? 1 : 0), 0),
          rows.length,
          config
        ) * 100).toFixed(1)}%.`
      );
    }
    if (sameSession && last) {
      reasons.push(
        `Match ${last.sessionMatchNo} of this session. Previous result: ${
          last.result === "win" ? "win" : "loss"
        }.${currentLossStreak > 1 ? ` Current streak: ${currentLossStreak} losses.` : ""}`
      );
    } else if (last) {
      reasons.push(`${Math.round(elapsedMin)} minutes since the last match; counted as a new session.`);
    }
    if (window) {
      reasons.push(
        `Next window estimate: ${(window.probability * 100).toFixed(1)}%.`
      );
    }
    if (modelState.enabled) {
      reasons.push(
        `The state model passed validation with ${Math.round(modelState.weight * 100)}% weight.`
      );
    } else {
      reasons.push("The state model did not pass validation. Using the historical baseline.");
    }

    return {
      code,
      title,
      summary,
      now: nowPrediction,
      breakEven,
      threshold,
      buffer,
      expectedNext,
      window,
      cooldownAt,
      reasons,
      guardReasons,
      sameSession,
      elapsedMin,
      playedInSession,
      currentLossStreak,
      currentWinStreak,
      last,
      bestFuture,
      plan: planOutcome(
        nowPrediction.probability,
        config,
        clamp(config.sessionCap, 5, 20)
      ),
    };
  }

  function analyze(input, configInput, clock) {
    const config = normalizeConfig(configInput);
    const now = clock instanceof Date ? clock.getTime() : parseDateTime(clock) || Date.now();
    const rows = deriveMatches(input, config);
    const model = trainAndValidate(rows, config);
    const forecast = buildForecast(rows, config, model, now, 24);
    const decision = buildDecision(rows, config, model, forecast, now);
    return {
      version: VERSION,
      now,
      config,
      rows,
      summary: summarize(rows),
      groups: buildGroups(rows, config),
      model,
      forecast,
      decision,
      breakEven: breakEvenProbability(config),
    };
  }

  function seededRandom(seed) {
    let state = seed >>> 0;
    return function random() {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createDemoMatches(clock, count) {
    const now = clock instanceof Date ? clock.getTime() : parseDateTime(clock) || Date.now();
    const target = clamp(Math.round(count || 240), 30, 2000);
    const random = seededRandom(20261026);
    const heroes = [
      "Sun Shangxiang",
      "Gongsun Li",
      "Da Qiao",
      "Wang Zhaojun",
      "Ji Xiaoman",
      "Xiahou Dun",
      "Zhao Yun",
      "Cai Wenji",
    ];
    const roles = ["Marksman", "Mid", "Support", "Clash", "Jungle"];
    const records = [];
    let cursor = now - 42 * DAY_MS;
    cursor = new Date(cursor).setHours(19, 10, 0, 0);
    const historyTarget = target - 5;
    let iterationGuard = 0;
    let sessionSequence = 0;

    while (records.length < historyTarget && cursor < now - 5 * 60 * 60 * 1000) {
      iterationGuard += 1;
      if (iterationGuard > target * 5) {
        break;
      }
      const sessionMode = sessionSequence % 2 === 0 ? "Ranked" : "Peak";
      sessionSequence += 1;
      const sessionLength = 2 + Math.floor(random() * 5);
      let previousResult = null;
      for (
        let sessionMatch = 1;
        sessionMatch <= sessionLength && records.length < historyTarget;
        sessionMatch += 1
      ) {
        if (cursor >= now - 5 * 60 * 60 * 1000) {
          break;
        }
        const hour = new Date(cursor).getHours();
        let probability =
          0.51 +
          (previousResult === "win" ? 0.025 : previousResult === "loss" ? -0.022 : 0) -
          Math.max(0, sessionMatch - 1) * 0.012 +
          (hour >= 18 ? 0.012 : hour < 6 ? -0.055 : 0);
        probability = clamp(probability, 0.37, 0.63);
        const result = random() < probability ? "win" : "loss";
        const duration = 14 + Math.round(random() * 13);
        const heroIndex = Math.floor(random() * heroes.length);
        const record = {
          id: `demo_${records.length}_${cursor}`,
          startAt: cursor,
          endAt: cursor + duration * 60 * 1000,
          result,
          mode: sessionMode,
          hero: heroes[heroIndex],
          role: roles[heroIndex % roles.length],
          starDelta: null,
          note: "Synthetic demo data",
          source: "demo",
        };
        records.push(record);
        previousResult = result;
        cursor += (duration + 3 + Math.floor(random() * 10)) * 60 * 1000;
      }
      const nextDayRoll = random();
      if (nextDayRoll < 0.72) {
        const baseDate = new Date(cursor);
        baseDate.setDate(baseDate.getDate() + 1);
        baseDate.setHours(19 + Math.floor(random() * 4), Math.floor(random() * 50), 0, 0);
        cursor = baseDate.getTime();
      } else {
        cursor += (70 + Math.floor(random() * 150)) * 60 * 1000;
      }
    }

    const tailStart = now - 158 * 60 * 1000;
    let previousResult = null;
    for (let index = 0; index < 5; index += 1) {
      const duration = 19 + (index % 3);
      const startAt = tailStart + index * 27 * 60 * 1000;
      let result =
        random() <
        (index === 4
          ? 0
          : 0.53 +
            (previousResult === "win" ? 0.025 : previousResult === "loss" ? -0.025 : 0) -
            index * 0.014)
          ? "win"
          : "loss";
      if (index === 4) {
        result = "loss";
      }
      const heroIndex = (index + 2) % heroes.length;
      records.push({
        id: `demo_tail_${index}_${startAt}`,
        startAt,
        endAt: startAt + duration * 60 * 1000,
        result,
        mode: "Ranked",
        hero: heroes[heroIndex],
        role: roles[heroIndex % roles.length],
        starDelta: null,
        note: "Synthetic demo data",
        source: "demo",
      });
      previousResult = result;
    }

    return records.sort((a, b) => a.startAt - b.startAt);
  }

  function toCsv(input) {
    const rows = deriveMatches(input, DEFAULT_CONFIG);
    const escape = (value) => {
      const text = String(value == null ? "" : value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const format = (value) => {
      if (!value) {
        return "";
      }
      const date = new Date(value);
      const pad = (number) => String(number).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours()
      )}:${pad(date.getMinutes())}`;
    };
    const header = ["start_time", "end_time", "result", "mode", "hero", "role", "delta", "note"];
    const lines = rows.map((row) =>
      [
        format(row.startAt),
        format(row.endAt),
        row.result,
        row.mode,
        row.hero,
        row.role,
        row.starDelta,
        row.note,
      ]
        .map(escape)
        .join(",")
    );
    return [header.join(","), ...lines].join("\r\n");
  }

  return {
    VERSION,
    DEFAULT_CONFIG,
    MODE_DEFINITIONS,
    TIME_BUCKETS,
    GAP_BUCKETS,
    normalizeConfig,
    parseDateTime,
    normalizeResult,
    normalizeMode,
    modeTypeOf,
    normalizeMatch,
    parseMatchesCsv,
    mergeMatches,
    deriveMatches,
    analyze,
    predictAt,
    wilsonInterval,
    smoothedRate,
    breakEvenProbability,
    planOutcome,
    createDemoMatches,
    toCsv,
    formatDayTime,
  };
});
