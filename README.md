# RankLab

Local match analysis for Honor of Kings Ranked and Peak queues.

## Run

Requires Node.js 20 or newer.

```bash
npm start
```

Open `http://127.0.0.1:4173`.

## Features

- Separate statistics, models, limits, and scoring for Ranked and Peak.
- CSV, TSV, and pasted data import.
- Manual match entry and local persistence.
- Win-rate confidence intervals and six conditional history splits.
- Chronological holdout validation before the state model affects a recommendation.
- Local CSV and JSON export.

## CSV

```csv
start_time,end_time,result,mode,hero,role,delta,note
2026-10-25 20:10,2026-10-25 20:31,win,Ranked,Sun Shangxiang,Marksman,1,
2026-10-26 21:10,2026-10-26 21:33,win,Peak,Da Qiao,Support,17,
```

`result`: `win`, `loss`, `1`, `0`, `胜`, or `负`  
`mode`: `Ranked`, `Peak`, `排位`, or `巅峰`  
`delta`: stars for Ranked; actual rating points for Peak when available

Chinese column names from the previous format remain supported.

## Decision Model

Break-even win rate:

```text
p* = loss / (win + loss)
```

The app estimates the next-match win rate from smoothed history and optional state features. A state model is used only when it beats a fixed-rate baseline on the final 30% of matches in chronological order.

Recommended actions apply user-defined session and loss limits. A wait window is shown only when the history supports one.

## Storage

Data stays in the browser's `localStorage`. The app does not use game APIs or account credentials.

## Sources

See [RESEARCH.md](RESEARCH.md).

## Test

```bash
npm test
```
