# Token Launch Radar

Entry for the make.fun bounty **token-radar-01** — "Build the best token launch radar"
($1,325 total; 1st $1,000; deadline 2026-12-14 18:00 Beijing).

**Entrant:** Jack (@jack-4) · **Status: local build only — NOT submitted.**

## What it is

A radar of every tokenless protocol DefiLlama tracks, ranked by what its
token launch would be worth, with a farm plan for each one:

- `main.ts` — the program (Node 22.18+, zero dependencies, no network).
  Reads `data/snapshot.json`, writes `board.json`, `dashboard/index.html`
  and `dossier.json`. Deterministic: two runs produce identical bytes.
- `board.json` — 342 rows, one per tokenless protocol family, ranked by
  implied launch value. Every row has an implied value and a 6-step farm plan.
- `dashboard/` — one self-contained static page (no network, no web
  addresses named anywhere in it): sortable board, detail drawer for every
  protocol, filters for chain / category / verdict / implied value.
- `dossier.json` — written by `vendor/makefun-board.ts` (see below).
- `screenshots/` — board, protocol detail view, filtered view.
- `transcripts/BUILD_LOG.md` — the build log for this entry.

## How the ranking works

1. Start from all 9,100 protocols in the snapshot.
2. Keep only those with **no token**: no symbol, no contract address, no
   CoinGecko id, no market cap. (4,708 removed.)
3. Drop TVL under $1M. (3,842 removed.)
4. Drop categories whose product is itself a tradable token — liquid
   staking / restaking, staking pools, bridges, wrapped assets — plus
   centralised exchanges, front-ends and chains. Drop names that are
   themselves a traded asset (stablecoins, wrapped tokens, deployments of a
   protocol that already trades). (189 + 7 removed.)
5. Merge version rows into one family row (12 merged). **Watchlist: 342 rows.**
6. **Implied FDV** = TVL × the median market-cap / TVL of tokenised peers
   in the same category (global median where a category has fewer than
   three peers), winsorised to [0.02, 5], capped at $5B. Curator /
   allocator TVL is haircut 25% because it double-counts capital already
   counted in the underlying protocols.
7. **Likelihood** (5%–95%) scores log TVL size, 7-day TVL growth, audits,
   multi-chain presence, age ≥ 1 year and the category's token-launch
   precedent.
8. **Implied value** = implied FDV × likelihood. The board is sorted by it.

Market cap here is circulating market cap — a conservative stand-in for
fully diluted value. No protocol on the board has announced a token.

Top of the board: Polymarket ($494M implied value), RocketSwap Anubis V2
($102M), Sentora Curator ($93M). See `dossier.json` for the full top 10.

## Reproduce

```sh
node main.ts            # writes board.json, dashboard/index.html, dossier.json
bash scripts/screenshot.sh   # 3 screenshots with headless Chromium
```

`main.ts` needs Node 22.18+ and nothing else. It reads only
`data/snapshot.json` and never touches the network. Screenshots are taken
separately (a plain Node run has no browser); `main.ts` verifies their
presence and records their SHA-256 hashes in `dossier.json`.

## Important: kit fallback

The bounty brief says to read a **sealed snapshot** and use the kit's
`vendor/makefun-board.ts` (with its `buildDossier`). Neither is obtainable
through any public channel: the bounty page and the public competitions API
expose no kit download, and the only pointer to the kit is
`make.fun/skill.md`, which failed a security check and was **not**
downloaded, installed or run. So:

- `data/snapshot.json` is the **live public DefiLlama snapshot**
  (`https://api.llama.fi/protocols`, fetched 2026-11-24) instead of the
  sealed snapshot. The live data is newer than the sealed one and may differ
  from it; the dossier states this plainly.
- `vendor/makefun-board.ts` is a **from-scratch reimplementation** of the
  described interface (gate validation + `buildDossier`). It is not the
  official kit file.

**Before submitting, re-run the official kit's `buildDossier` and the
sealed snapshot, and re-check the gate.** A submission built on the fallback
may fail the harness gate (for example, the harness expects `main.ts` to
write `screenshots/` itself, which a plain Node run cannot do without a
browser).

## What is still missing for a valid submission

- [ ] Official kit (`vendor/makefun-board.ts` + sealed snapshot) — obtain
      through the platform's normal entry flow, inspect before running.
- [ ] Re-run with the sealed snapshot and the official `buildDossier`.
- [ ] Public GitHub repo (created after the competition opened, 2026-11-14),
      OSI license (MIT included here), `main.ts` in the root.
- [ ] Agent transcripts uploaded with the submission (see `transcripts/`).
- [ ] Submit via make.fun (max 5/day, 10 total; last before the deadline
      is final). Do not submit this local build as-is.

## License

MIT — see `LICENSE`.
