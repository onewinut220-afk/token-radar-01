# Build log — Token Launch Radar (token-radar-01)

Agent build transcript for the make.fun bounty entry. Local build only;
nothing was submitted, no repo was created, nothing was paid.

## Session

- Date: 2026-11-24 (build started ~12:20 UTC)
- Entrant: Jack (@jack-4), wallet F8aX5M93DXuJodpxBDyAzA6yvdkXMwQd7K6YVMY3rq8u (linked)
- Bounty: token-radar-01, $1,325, deadline 2026-12-14 10:00 UTC
- Environment: Node v24.22.1 (system), Chromium 158 headless shell
  (animation toolchain), Python 3.12 for analysis only

## Steps taken

1. Read the public bounty brief at https://make.fun/bounty/token-radar-01
   and the competition record at https://make.fun/api/competitions
   (30,914 submissions at build time). Gate rules recovered from the API
   `resolution.criteria`: board 100–4000 rows, whole watchlist covered,
   3–12 farm steps of 20–600 chars per row, dashboard ≤ 400 files and
   ≤ 4 MiB naming no network address, 3–4 screenshots, dossier.json as
   `buildDossier` writes it, program runs twice with identical bytes.
2. Searched the bounty page HTML and the public API for a kit download
   (vendor/makefun-board.ts, sealed snapshot). None exists in any public
   channel. The only pointer is make.fun/skill.md, which failed a
   security check earlier and was NOT downloaded, installed or run.
   Decision: build on the fallback (live public DefiLlama snapshot) and
   reimplement `vendor/makefun-board.ts` from the published interface,
   with the fallback stated in every deliverable.
3. Fetched the live DefiLlama snapshot: `curl https://api.llama.fi/protocols`
   → `data/snapshot.json` (9,100 protocols, 2026-11-24).
4. Data analysis (Python, exploratory only): the API marks a missing token
   with symbol `"-"`, not null — an early count that treated `"-"` as a
   token was wrong and was corrected (4,392 tokenless, not 2). Peer
   multiples computed per category from tokenised protocols (median
   market-cap / TVL).
5. Wrote `vendor/makefun-board.ts` (reimplementation: gate validation +
   `buildDossier`) and `main.ts` (pipeline, ranking, farm plans,
   dashboard generator). No dependencies, no network, deterministic.
6. First run: 345 rows, validation PASS. Audit found three bugs and fixed
   them: (a) `audits` is a string in the API, so every row showed 0
   audits — fixed with a parser; (b) category "Cross Chain Bridge"
   (Circle Gateway) was not excluded — added; (c) deployments of
   protocols that already trade (GMX Solana, Stacks sBTC, SolvBTC LSTs,
   Zircuit Staking, Mantle Restaking, OKX xBTC, Starknet BTC Staking,
   Gate SOL, RHEA LST, Phantom SOL, Nexus BTC) were on the board — added
   to the name denylist.
7. Re-ran twice: identical SHA-256 for board.json, dossier.json and
   dashboard/index.html across runs (determinism check). Final board:
   342 rows, validation PASS.
8. Screenshots: the chrome-headless-shell one-shot `--screenshot` flag
   hangs in this VM (zygote/network-service crash loop, even on a trivial
   page), while the same binary serves CDP fine — so screenshots were
   taken over CDP by `scripts/screenshot.mjs` (Node, no dependencies).
   First capture showed all three shots identical: hash-only navigations
   do not reload the page, so the detail drawer / filter never applied.
   Fixed with a `hashchange` listener + `applyHash()` in the dashboard
   and an explicit `applyHash()` / `closeDetail()` call in the driver;
   re-captured and inspected all three visually: 01-board (342 rows),
   02-detail (Polymarket drawer + farm plan), 03-filtered (Solana,
   43 of 342 shown).
9. Re-ran `main.ts` after screenshots so `dossier.json` records their
   file sizes and SHA-256 hashes.

## Key decisions

- Watchlist = tokenless + TVL ≥ $1M, minus wrapped/staked/bridge/CEX/
  front-end/chain categories, minus traded-asset names, version rows
  merged into families. 342 rows. The threshold and exclusions are
  stated in `dossier.json` so the watchlist is reproducible.
- Ranking = TVL × category peer multiple (median mcap/TVL, winsorised
  [0.02, 5], capped FDV $5B, curator haircut 0.25×) × likelihood
  (size, 7d growth, audits, multi-chain, age, category precedent).
  Market cap is circulating mcap, a conservative FDV proxy.
- Dashboard is a single static file (535–543 KB) with the board inlined
  at the end, so the first 64 KB the judge reads is real UI, not JSON.
  It names no web address anywhere (gate requirement).
- Farm plans are 6 steps each, category-specific, 20–600 chars, no URLs.

## Known gaps (see README.md)

- Official kit + sealed snapshot still missing; re-run with them before
  submitting.
- `main.ts` does not take screenshots itself (no browser in a plain Node
  run); the harness may expect it to.
- TVL-anchored model undervalues products with no TVL (wallets, social
  apps, marketplaces) and prediction markets (TVL is collateral, not
  business value). Stated in the dossier and on the dashboard.
- A few snapshot rows look like data-quality outliers (large TVL on the
  obscure Anubis chain, future listing dates); kept as reported.
