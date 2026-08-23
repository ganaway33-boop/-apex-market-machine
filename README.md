# -apex-market-machine

APEX+ Market Machine — feature/apex-ui

This repository contains the APEX+ Market Machine, an evidence-first market intelligence dashboard built as a self-contained static web app. The feature/apex-ui branch contains the production-ready UI improvements and the APEX scoring engine in a demo-first configuration.

---

## Architecture

- index.html — single-page UI. Mobile-first, dark trading-terminal design. Loads `apex-core.js` for the engine logic.
- apex-core.js — core APEX engine: data adapter (DEMO/LIVE/UNAVAILABLE), deterministic scoring, PRIME gating, NO-TRADE rules, cycle-to-cycle state, per-ticker history storage, and safe public API hooks.
- tests.html — lightweight browser tests for scoring, PRIME gating, NO-TRADE logic, invalidation, and cycle state.

The UI is intentionally self-contained and lightweight (no external JS libs). `apex-core.js` exposes a clear adapter interface so a live market-data provider can be wired later without changing the scoring engine.

---

## Scoring methodology (evidence-first)

APEX scores each setup on a 0–100 scale by combining interpretable factor scores:

- Regime alignment (weight 12%) — does the trade direction match the detected market regime?
- Catalyst credibility (15%) — objective credibility estimate (0..1) of relevant news or event
- Abnormal volume (15%) — relative volume spike vs baseline
- Momentum (18%) — short-term momentum signal strength
- Multi-timeframe confirmation (12%) — number of higher-timeframe confirmations (0..3)
- Independent confirmations (12%) — number of independent signals/confirmations (0..3)
- Liquidity / spread (6%) — liquidity goodness (0..1)
- Risk/Reward (10%) — R/R normalized (0..1 where R/R >=2 is strong)

Each factor is normalized to 0..1 and multiplied by its weight. The final raw score is the sum of weighted factors mapped to 0–100. The engine also returns a per-factor contribution breakdown so every score can be explained.

---

## PRIME criteria (strict gating)

A setup is labeled PRIME only when ALL of the following are satisfied:

- Deterministic APEX score >= 80
- Independent confirmations >= 2
- Multi-timeframe confirmations >= 2
- Liquidity >= 0.5 (sensible spread/slippage)
- Risk/Reward >= 1.5 (preferably >= 2.0)
- No overriding NO-TRADE condition (see below)

PRIME is intentionally conservative: multiple independent confirmations and multi-TF alignment are required.

---

## NO-TRADE criteria (overrides)

The engine will force NO-TRADE when any of these conditions are met:

- Liquidity is poor (liq < 0.25)
- Risk/Reward unacceptable (r_r < 1.0)
- Catalyst credibility is very weak AND confirmations are absent
- Evidence conflicts (e.g., strong momentum against weak confirmations/catalyst)
- Invalidation levels are unclear or stop would be excessively wide relative to price

NO-TRADE overrides even a high raw score. Reasons for NO-TRADE are provided in the explanation.

---

## Cycle-to-cycle state

Each scan compares the current evaluation to the previous scan and computes a state for each setup:
- NEW — first time seen
- IMPROVING — score increased and status improved
- CONFIRMED — status remains PRIME or WATCH and confirmations increased or stable
- DETERIORATING — score decreased significantly or status downgraded
- INVALIDATED — setup moved to NO-TRADE or price invalidation observed
- UNCHANGED — no material change

History per ticker is stored in `localStorage` (key `apex_history_{TICKER}`) with up to 50 recent entries so the UI can display trends.

---

## DEMO vs LIVE vs UNAVAILABLE

- DEMO: App includes demo data. The UI clearly labels DEMO mode and warns that data is not live. This is the default in the feature branch.
- LIVE: When you provide a market-data provider and credentials, wire the adapter in `apex-core.js` in `fetchLiveData()` (safe error handling and rate-limiting required).
- UNAVAILABLE: When the adapter signals no data, the UI shows UNAVAILABLE. The app never claims demo or cached data is live.

---

## Development

Run locally:

1. Serve the repo root as a static site (Python example):

   python -m http.server 8000

2. Open http://localhost:8000/index.html

Interact with the UI and inspect the console for test output.

---

## Tests

Open `tests.html` in a browser. Tests run in the browser and print results to the console and on-page. Tests cover:
- scoring determinism and factor breakdown presence
- PRIME gating rules
- NO-TRADE overrides
- invalidation behavior
- cycle-to-cycle state transitions

---

## Deployment

This repository is ready for GitHub Pages. Use one of the following:

- Serve feature branch directly (for staging): Pages -> Source: feature/apex-ui
- Merge to main (after review) and serve from main

---

## Future API integration plan

- Implement `fetchLiveData()` in `apex-core.js` to return the same data shape used in DEMO data (fields: ticker, price, direction, catalyst, catalystCred, volume, momentum, r_r, liq, multiTF, confSignals, entry, target, stop, invalidation).
- Add secure storage for API credentials (GitHub Actions secrets, server-side proxy) and rate-limiting.
- Keep the scoring engine unchanged; the adapter should transform provider-specific payloads into the engine's data shape.

---

## Important notes

- This system is a decision-support tool. It does NOT predict the market or guarantee profits.
- The engine is intentionally conservative (strict PRIME gating and NO-TRADE overrides).

