(function () {
  "use strict";

  const engine = window.MatchEngine;
  const STORAGE_KEY = "pvp-match-decision-lab:v1";
  const MODES = {
    ranked: { label: "Ranked", unit: "stars", note: "Stars · solo or party play" },
    peak: { label: "Peak", unit: "points", note: "Points · primarily solo queue" },
  };
  const SOURCES = [
    {
      type: "Official",
      title: "Role-based matchmaking test",
      text: "The official post describes match quality, role preferences, and queue time as competing factors.",
      url: "https://pvp.qq.com/webplat/info/news_version3/15592/24418/24987/24988/m18519/201906/814874.shtml",
    },
    {
      type: "Official",
      title: "Timed ranked matchmaking test",
      text: "A separate algorithm was tested for non-five-player ranked draft queues at a specific time window.",
      url: "https://2.pvp.qq.com/webplat/info/news_version3/15592/24091/24092/24095/m15241/201906/812495.shtml",
    },
    {
      type: "Official",
      title: "S42 Peak changes",
      text: "Peak lanes and ranking structures changed; full matchmaking weights remain unpublished.",
      url: "https://pvp.qq.com/web201706/newsdetail.shtml?tid=789586",
    },
    {
      type: "Official",
      title: "S45 season update",
      text: "Ranked and Peak season settlement are handled separately, with a dedicated Peak inheritance rule.",
      url: "https://pvp.qq.com/web201706/newsdetail.shtml?tid=808620",
    },
    {
      type: "Paper",
      title: "Real-time win prediction",
      text: "The model predicts an in-progress match from live features; it does not establish pre-match result control.",
      url: "https://arxiv.org/abs/2008.06313",
    },
    {
      type: "GitHub",
      title: "GloryOfKings_CampData",
      text: "An older attempt to infer ELO or MMR from Camp records. Its README reports an inconclusive result.",
      url: "https://github.com/Ubastic/GloryOfKings_CampData",
    },
    {
      type: "GitHub",
      title: "Honor-of-Kings-Match-Statistics",
      text: "A match scraper with a community interpretation of the WarmBattle field. The interpretation is not officially confirmed.",
      url: "https://github.com/as167888/Honor-of-Kings-Match-Statistics",
    },
    {
      type: "GitHub",
      title: "honor_of_kings_stats_analyzer",
      text: "A descriptive notebook covering win rate, KDA, MVP, side, and daily star changes.",
      url: "https://github.com/guihuashaoxiang/honor_of_kings_stats_analyzer",
    },
  ];

  function defaultConfigs() {
    return {
      ranked: engine.normalizeConfig({ ...engine.DEFAULT_CONFIG, winPoints: 1, lossPoints: 1 }),
      peak: engine.normalizeConfig({ ...engine.DEFAULT_CONFIG, winPoints: 20, lossPoints: 20 }),
    };
  }

  const configs = defaultConfigs();
  const state = {
    matches: [],
    configs,
    activeMode: "ranked",
    config: configs.ranked,
    source: "demo",
    analysis: null,
    tab: "decision",
    toastTimer: null,
  };

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => [...(root || document).querySelectorAll(selector)];

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function percent(value, digits) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${(value * 100).toFixed(digits == null ? 1 : digits)}%`;
  }

  function signed(value, digits) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    const text = Number(value).toFixed(digits == null ? 1 : digits);
    return value > 0 ? `+${text}` : text;
  }

  function clock(value) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  }

  function dateTime(value) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  }

  function modeOf(match) {
    return match.modeType || engine.modeTypeOf(match.mode);
  }

  function modeCounts() {
    return state.matches.reduce(
      (counts, match) => {
        const mode = modeOf(match);
        if (counts[mode] != null) {
          counts[mode] += 1;
        }
        return counts;
      },
      { ranked: 0, peak: 0, other: 0 }
    );
  }

  function activeMatches() {
    return state.matches.filter((match) => modeOf(match) === state.activeMode);
  }

  function save() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        matches: state.matches,
        configs: state.configs,
        activeMode: state.activeMode,
        source: state.source,
      })
    );
  }

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      saved = null;
    }
    if (saved && Array.isArray(saved.matches)) {
      state.matches = saved.matches;
      state.source = ["demo", "user", "empty"].includes(saved.source) ? saved.source : "user";
      state.activeMode = ["ranked", "peak"].includes(saved.activeMode) ? saved.activeMode : "ranked";
      const base = saved.config || engine.DEFAULT_CONFIG;
      state.configs = {
        ranked: engine.normalizeConfig({
          ...base,
          ...(saved.configs?.ranked || {}),
          winPoints: saved.configs?.ranked?.winPoints ?? base.winPoints ?? 1,
          lossPoints: saved.configs?.ranked?.lossPoints ?? base.lossPoints ?? 1,
        }),
        peak: engine.normalizeConfig({
          ...base,
          ...(saved.configs?.peak || {}),
          winPoints: saved.configs?.peak?.winPoints ?? 20,
          lossPoints: saved.configs?.peak?.lossPoints ?? 20,
        }),
      };
    }
    if (state.source === "demo") {
      state.matches = engine.createDemoMatches(new Date(), 240);
    }
    state.config = state.configs[state.activeMode];
  }

  function setTab(name) {
    if (!["decision", "evidence", "data", "sources"].includes(name)) {
      return;
    }
    state.tab = name;
    $$(".tab").forEach((button) => {
      const active = button.dataset.tab === name;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    $$(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${name}`;
    });
    history.replaceState(null, "", `#${name}`);
  }

  function setMode(mode) {
    if (!MODES[mode] || mode === state.activeMode) {
      return;
    }
    state.activeMode = mode;
    state.config = state.configs[mode];
    save();
    syncSettings();
    update();
  }

  function sourceText() {
    const counts = modeCounts();
    if (state.source === "demo") {
      return `Demo · Ranked ${counts.ranked} · Peak ${counts.peak}`;
    }
    if (state.source === "user") {
      return `Local · Ranked ${counts.ranked} · Peak ${counts.peak}`;
    }
    return "No data";
  }

  function renderHeader() {
    $("#source-pill").textContent = sourceText();
    const counts = modeCounts();
    $("#ranked-count").textContent = counts.ranked;
    $("#peak-count").textContent = counts.peak;
    $("#mode-note").textContent = MODES[state.activeMode].note;
    $$(".mode").forEach((button) => {
      const active = button.dataset.mode === state.activeMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
  }

  function syncSettings() {
    const form = $("#settings-form");
    for (const [name, value] of Object.entries(state.config)) {
      const input = form.elements.namedItem(name);
      if (input) {
        input.value = value;
      }
    }
    const peak = state.activeMode === "peak";
    $("#win-label").textContent = peak ? "Win points" : "Win stars";
    $("#loss-label").textContent = peak ? "Loss points" : "Loss stars";
    $("#points-note").textContent = peak
      ? "Peak delta varies by rating. Enter the actual change for each match when possible."
      : "Default delta is ±1 star when no value is supplied.";
    $("#manual-mode").selectedIndex = peak ? 1 : 0;
  }

  function update() {
    state.analysis = engine.analyze(activeMatches(), state.config, Date.now());
    renderHeader();
    renderDecision();
    renderEvidence();
    renderData();
    renderSources();
  }

  function emptyState(title, body) {
    return `<div class="card empty"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(
      body
    )}</p><button class="button primary" type="button" data-go-tab="data">Import data</button></div>`;
  }

  function renderDecision() {
    const root = $("#decision-root");
    const analysis = state.analysis;
    const matches = activeMatches();
    const mode = MODES[state.activeMode];
    if (!analysis || !matches.length) {
      root.innerHTML = emptyState(`No ${mode.label} matches`, "Import a match history to start.");
      return;
    }
    const decision = analysis.decision;
    const prediction = decision.now;
    const window = decision.window;
    const windowText =
      decision.code === "play" || decision.code === "cautious"
        ? "Now"
        : window
          ? `${engine.formatDayTime(window.start, analysis.now)}–${clock(window.end)}`
          : decision.code === "wait" && decision.cooldownAt
            ? `${clock(decision.cooldownAt)} or later`
            : "Not scheduled";
    const windowDetail = window ? percent(window.probability) : "No supported edge";

    root.innerHTML = `
      <section class="decision ${escapeHtml(decision.code)}" aria-labelledby="decision-title">
        <div class="decision-main">
          <span class="eyebrow">NEXT MATCH · ${escapeHtml(mode.label.toUpperCase())}</span>
          <h1 id="decision-title" class="decision-title">${escapeHtml(decision.title)}</h1>
          <p>${escapeHtml(decision.summary)}</p>
          <span class="decision-meta">${matches.length} matches · ${escapeHtml(
            state.source === "demo" ? "demo data" : "local data"
          )}</span>
        </div>
        <aside class="decision-side">
          <span>Estimated win rate</span>
          <strong class="probability">${percent(prediction.probability)}</strong>
          <span>${percent(prediction.lower)}–${percent(prediction.upper)} at 95%</span>
          <div class="window">
            <span>Recommended window</span>
            <strong>${escapeHtml(windowText)}</strong>
            <small>${escapeHtml(windowDetail)}</small>
          </div>
        </aside>
      </section>

      <div class="metrics">
        <div class="metric"><span>Break-even rate</span><strong>${percent(
          decision.breakEven
        )}</strong><small>Action threshold ${percent(decision.threshold)}</small></div>
        <div class="metric"><span>Next-match value</span><strong>${signed(
          decision.expectedNext,
          2
        )}</strong><small>${escapeHtml(mode.unit)}</small></div>
        <div class="metric"><span>Overall win rate</span><strong>${percent(
          analysis.summary.rate
        )}</strong><small>${analysis.summary.wins} wins · ${
          analysis.summary.losses
        } losses</small></div>
        <div class="metric"><span>Current session</span><strong>${
          decision.playedInSession
        }</strong><small>Limit ${state.config.sessionCap} matches</small></div>
      </div>

      <div class="grid decision-grid">
        <section class="card">
          <div class="card-head"><div><h2>Signals</h2><p>Inputs behind this decision.</p></div></div>
          <ul class="reason-list">${decision.reasons
            .map((reason) => `<li>${escapeHtml(reason)}</li>`)
            .join("")}</ul>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Session rules</h2><p>Current mode only.</p></div></div>
          <ul class="rule-list">
            <li><strong>Matches played</strong><span>${decision.playedInSession} / ${
              state.config.sessionCap
            }</span><div class="bar"><i style="width:${Math.min(
              100,
              (decision.playedInSession / state.config.sessionCap) * 100
            ).toFixed(1)}%"></i></div></li>
            <li><strong>Loss streak</strong><span>${decision.currentLossStreak} / ${
              state.config.stopLossStreak
            }</span><div class="bar"><i style="width:${Math.min(
              100,
              (decision.currentLossStreak / state.config.stopLossStreak) * 100
            ).toFixed(1)}%"></i></div></li>
            <li><strong>Model</strong><span>${
              analysis.model.enabled
                ? `Active · ${percent(analysis.model.weight, 0)} weight`
                : "Baseline"
            }</span></li>
          </ul>
        </section>
      </div>

      <section class="card spaced">
        <div class="card-head"><div><h2>24-hour forecast</h2><p>Point estimate and uncertainty.</p></div></div>
        <div class="chart-wrap">${renderChart(analysis)}</div>
      </section>`;
  }

  function renderChart(analysis) {
    const rows = analysis.forecast;
    if (!rows.length) {
      return "";
    }
    const width = 860;
    const height = 260;
    const left = 52;
    const right = 20;
    const top = 20;
    const bottom = 42;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const start = rows[0].at;
    const end = rows[rows.length - 1].at;
    const allValues = rows.flatMap((row) => [row.lower, row.upper]);
    allValues.push(analysis.decision.breakEven);
    let low = Math.max(0.2, Math.min(...allValues) - 0.02);
    let high = Math.min(0.8, Math.max(...allValues) + 0.02);
    if (high - low < 0.08) {
      const middle = (high + low) / 2;
      low = middle - 0.04;
      high = middle + 0.04;
    }
    const x = (value) => left + ((value - start) / Math.max(1, end - start)) * plotWidth;
    const y = (value) => top + ((high - value) / Math.max(0.001, high - low)) * plotHeight;
    const line = rows
      .map((row, index) => `${index ? "L" : "M"}${x(row.at).toFixed(1)},${y(row.probability).toFixed(1)}`)
      .join(" ");
    const band = [
      ...rows.map((row, index) => `${index ? "L" : "M"}${x(row.at).toFixed(1)},${y(row.upper).toFixed(1)}`),
      ...rows.slice().reverse().map((row) => `L${x(row.at).toFixed(1)},${y(row.lower).toFixed(1)}`),
      "Z",
    ].join(" ");
    const ticks = Array.from({ length: 5 }, (_, index) => low + ((high - low) * index) / 4);
    const timeTicks = [0, 6, 12, 18, 24];
    const recommended = analysis.decision.window;
    return `
      <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="24-hour win probability forecast. Current estimate ${percent(
        analysis.decision.now.probability
      )}, break-even ${percent(analysis.decision.breakEven)}.">
        ${recommended && recommended.start >= start && recommended.end <= end + 1800000
          ? `<rect class="window-band" x="${x(recommended.start)}" y="${top}" width="${Math.max(
              2,
              x(recommended.end) - x(recommended.start)
            )}" height="${plotHeight}" />`
          : ""}
        ${ticks
          .map(
            (tick) =>
              `<line class="grid-line" x1="${left}" x2="${width - right}" y1="${y(
                tick
              )}" y2="${y(tick)}" /><text x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${percent(
                tick,
                0
              )}</text>`
          )
          .join("")}
        <line class="reference" x1="${left}" x2="${width - right}" y1="${y(
          analysis.decision.breakEven
        )}" y2="${y(analysis.decision.breakEven)}" />
        ${timeTicks
          .map((hours) => {
            const at = Math.min(start + hours * 3600000, end);
            return `<text x="${x(at)}" y="${height - 14}" text-anchor="${
              hours === 0 ? "start" : hours === 24 ? "end" : "middle"
            }">${escapeHtml(engine.formatDayTime(at, analysis.now))}</text>`;
          })
          .join("")}
        <path class="band" d="${band}" />
        <path class="line" d="${line}" />
        <line class="now" x1="${x(analysis.now)}" x2="${x(analysis.now)}" y1="${top}" y2="${
          top + plotHeight
        }" />
      </svg>`;
  }

  function renderGroup(title, groups, breakEven) {
    const body = groups.length
      ? groups
          .map(
            (group) => `
            <div class="evidence-row">
              <div class="name">${escapeHtml(group.label)}<small>n=${group.n}${
                group.lowSample ? " · low sample" : ""
              }</small></div>
              <div class="bar"><i style="width:${(group.rate * 100).toFixed(1)}%"></i></div>
              <div class="value">${percent(group.rate)}<small>${percent(
                group.lower,
                0
              )}–${percent(group.upper, 0)}</small></div>
            </div>`
          )
          .join("")
      : `<p class="subtle">No sample</p>`;
    return `<section class="evidence-card"><h3>${escapeHtml(
      title
    )}</h3>${body}<p class="subtle">Break-even: ${percent(breakEven)}</p></section>`;
  }

  function renderEvidence() {
    const root = $("#evidence-root");
    const analysis = state.analysis;
    if (!analysis || !activeMatches().length) {
      root.innerHTML = emptyState("No evidence", "Import matches for this mode.");
      return;
    }
    const validation = analysis.model.validation;
    root.innerHTML = `
      <div class="metrics">
        <div class="metric"><span>Matches</span><strong>${analysis.summary.n}</strong><small>${
          analysis.summary.wins
        } wins · ${analysis.summary.losses} losses</small></div>
        <div class="metric"><span>Win rate</span><strong>${percent(
          analysis.summary.rate
        )}</strong><small>${percent(analysis.summary.lower)}–${percent(
          analysis.summary.upper
        )}</small></div>
        <div class="metric"><span>Recent 20</span><strong>${percent(
          analysis.summary.recentRate
        )}</strong><small>Current form</small></div>
        <div class="metric"><span>Net ${MODES[state.activeMode].unit}</span><strong>${signed(
          analysis.summary.stars,
          1
        )}</strong><small>Per match ${signed(analysis.summary.starsPerMatch, 2)}</small></div>
      </div>
      <div class="evidence-grid spaced">
        ${renderGroup("After previous result", analysis.groups.afterResult, analysis.breakEven)}
        ${renderGroup("Rest interval", analysis.groups.gap, analysis.breakEven)}
        ${renderGroup("Session position", analysis.groups.sessionPosition, analysis.breakEven)}
        ${renderGroup("Time of day", analysis.groups.time, analysis.breakEven)}
      </div>
      <section class="card spaced">
        <div class="card-head">
          <div><h2>Model validation</h2><p>Chronological holdout: first 70% train, last 30% validation.</p></div>
          <span class="pill">${analysis.model.enabled ? "Active" : "Baseline"}</span>
        </div>
        <div class="metrics">
          <div class="metric"><span>Baseline Brier</span><strong>${
            validation ? validation.baselineBrier.toFixed(4) : "--"
          }</strong></div>
          <div class="metric"><span>Model Brier</span><strong>${
            validation ? validation.adaptiveBrier.toFixed(4) : "--"
          }</strong></div>
          <div class="metric"><span>Improvement</span><strong>${
            validation ? signed(validation.improvement, 4) : "--"
          }</strong></div>
          <div class="metric"><span>Decision weight</span><strong>${percent(
            analysis.model.weight,
            0
          )}</strong></div>
        </div>
      </section>`;
  }

  function renderData() {
    const counts = modeCounts();
    const current = state.analysis?.summary || { n: 0, wins: 0, losses: 0, stars: 0 };
    $("#data-summary").textContent = `${MODES[state.activeMode].label}: ${current.wins}W–${
      current.losses
    }L · ${signed(current.stars, 1)} ${MODES[state.activeMode].unit} · Total ${counts.ranked + counts.peak}`;
    const rows = ["ranked", "peak"]
      .flatMap((mode) =>
        engine.deriveMatches(
          state.matches.filter((match) => modeOf(match) === mode),
          state.configs[mode]
        )
      )
      .sort((a, b) => b.startAt - a.startAt)
      .slice(0, 150);
    const table = $("#match-table");
    table.innerHTML = rows.length
      ? rows
          .map(
            (row) => `<tr>
              <td>${escapeHtml(dateTime(row.startAt))}</td>
              <td>${escapeHtml(row.mode)}</td>
              <td class="${row.result}">${row.result === "win" ? "Win" : "Loss"}</td>
              <td>${escapeHtml(row.hero || "—")}</td>
              <td>${row.sessionMatchNo}</td>
              <td>${signed(row.starDelta, 1)}</td>
              <td><button class="button small danger" data-delete="${escapeHtml(
                row.id
              )}" type="button">Delete</button></td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="7" class="subtle">No matches</td></tr>`;
  }

  function renderSources() {
    $("#sources-root").innerHTML = `<div class="source-list">${SOURCES.map(
      (source) => `
      <article class="source-card">
        <span class="level">${escapeHtml(source.type)}</span>
        <div>
          <h3>${escapeHtml(source.title)}</h3>
          <p>${escapeHtml(source.text)}</p>
          <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Open source</a>
        </div>
      </article>`
    ).join("")}</div>`;
  }

  function showToast(text, error) {
    const toast = $("#toast");
    toast.textContent = text;
    toast.classList.toggle("error", Boolean(error));
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  function parseSettings() {
    const values = Object.fromEntries(new FormData($("#settings-form")).entries());
    state.config = engine.normalizeConfig({ ...state.config, ...values });
    state.configs[state.activeMode] = state.config;
    save();
    update();
    syncSettings();
  }

  function setImportStatus(text, error) {
    const element = $("#import-status");
    element.textContent = text;
    element.classList.toggle("error", Boolean(error));
  }

  function importText(text, label) {
    const result = engine.parseMatchesCsv(text);
    if (!result.matches.length) {
      const message = result.errors.slice(0, 2).join(" ");
      setImportStatus(message || "No valid matches.", true);
      return;
    }
    const base = state.source === "demo" ? [] : state.matches;
    const before = base.length;
    state.matches = engine.mergeMatches(base, result.matches);
    state.source = "user";
    const imported = result.matches.reduce(
      (counts, match) => {
        const mode = modeOf(match);
        if (counts[mode] != null) {
          counts[mode] += 1;
        }
        return counts;
      },
      { ranked: 0, peak: 0, other: 0 }
    );
    if (!activeMatches().length || imported.peak > imported.ranked) {
      state.activeMode = imported.peak > imported.ranked ? "peak" : "ranked";
      state.config = state.configs[state.activeMode];
    }
    save();
    syncSettings();
    update();
    const added = state.matches.length - before;
    const warning = result.errors.length ? ` · ${result.errors.length} skipped` : "";
    setImportStatus(`${label}: ${added} added${warning}`, false);
    setTab("decision");
  }

  function readFile(file) {
    if (!file) {
      return;
    }
    file.text().then((text) => importText(text, file.name));
  }

  function toLocalInput(value) {
    const date = new Date(value);
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  }

  function download(text, name, type) {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function template() {
    download(
      [
        "start_time,end_time,result,mode,hero,role,delta,note",
        "2026-10-25 20:10,2026-10-25 20:31,win,Ranked,Sun Shangxiang,Marksman,1,",
        "2026-10-26 21:10,2026-10-26 21:33,win,Peak,Da Qiao,Support,17,",
      ].join("\r\n"),
      "rank-lab-template.csv",
      "text/csv"
    );
  }

  function exportCsv() {
    if (!state.matches.length) {
      showToast("No match data.", true);
      return;
    }
    download(engine.toCsv(state.matches), "rank-lab-matches.csv", "text/csv");
  }

  function exportJson() {
    if (!state.matches.length) {
      showToast("No match data.", true);
      return;
    }
    download(
      JSON.stringify(
        { version: 3, mode: state.activeMode, configs: state.configs, matches: state.matches },
        null,
        2
      ),
      "rank-lab-backup.json",
      "application/json"
    );
  }

  function bind() {
    $$(".tab").forEach((button) => {
      button.addEventListener("click", () => setTab(button.dataset.tab));
    });
    $$(".mode").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });
    document.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-go-tab]");
      if (tab) {
        setTab(tab.dataset.goTab);
      }
      const remove = event.target.closest("[data-delete]");
      if (remove) {
        state.matches = state.matches.filter((match) => match.id !== remove.dataset.delete);
        state.source = state.matches.length ? "user" : "empty";
        if (!activeMatches().length) {
          const counts = modeCounts();
          state.activeMode = counts.peak > 0 ? "peak" : "ranked";
          state.config = state.configs[state.activeMode];
        }
        save();
        syncSettings();
        update();
      }
    });
    $("#refresh-button").addEventListener("click", update);
    $("#settings-form").addEventListener("change", parseSettings);
    $("#import-button").addEventListener("click", () =>
      importText($("#csv-paste").value, "Paste")
    );
    $("#csv-file").addEventListener("change", (event) => {
      readFile(event.target.files[0]);
      event.target.value = "";
    });
    const drop = $("#drop-zone");
    ["dragenter", "dragover"].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add("dragging");
      })
    );
    ["dragleave", "drop"].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.remove("dragging");
      })
    );
    drop.addEventListener("drop", (event) => readFile(event.dataTransfer.files[0]));
    $("#demo-button").addEventListener("click", () => {
      if (state.source === "user" && !window.confirm("Replace local match data with demo data?")) {
        return;
      }
      state.source = "demo";
      state.matches = engine.createDemoMatches(new Date(), 240);
      save();
      syncSettings();
      update();
      setTab("decision");
    });
    $("#manual-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const match = engine.normalizeMatch({
          startAt: form.get("startAt"),
          endAt: form.get("endAt"),
          result: form.get("result"),
          mode: form.get("mode"),
          hero: form.get("hero"),
          starDelta: form.get("starDelta"),
          source: "manual",
        });
        state.matches = engine.mergeMatches(state.source === "demo" ? [] : state.matches, [match]);
        state.source = "user";
        state.activeMode = modeOf(match);
        state.config = state.configs[state.activeMode];
        event.currentTarget.reset();
        $("#manual-start").value = toLocalInput(Date.now());
        save();
        syncSettings();
        update();
        setTab("decision");
      } catch (error) {
        showToast(error.message, true);
      }
    });
    $("#template-button").addEventListener("click", template);
    $("#export-csv").addEventListener("click", exportCsv);
    $("#export-json").addEventListener("click", exportJson);
    $("#clear-data").addEventListener("click", () => {
      if (!state.matches.length || !window.confirm("Clear all local match data?")) {
        return;
      }
      state.matches = [];
      state.source = "empty";
      save();
      syncSettings();
      update();
    });
  }

  function init() {
    load();
    bind();
    syncSettings();
    $("#manual-start").value = toLocalInput(Date.now());
    update();
    const hash = location.hash.slice(1);
    setTab(["decision", "evidence", "data", "sources"].includes(hash) ? hash : "decision");
    setInterval(() => {
      if (!document.hidden) {
        update();
      }
    }, 60000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
