// main.ts — Token Launch Radar (make.fun bounty token-radar-01)
//
// Reads a DefiLlama protocol snapshot, finds the tokenless watchlist,
// ranks it by implied launch value, and writes board.json, dashboard/ and
// dossier.json. Deterministic: no wall clock, no network. Run with:
//   node main.ts            (Node 22.18+; system node here is v24)
//   OUT_DIR=/output node main.ts
//
// FALLBACK NOTICE: the bounty brief says to read a sealed snapshot from the
// kit. The kit (vendor/makefun-board.ts + sealed snapshot) is not obtainable
// through any public channel — the bounty page and public API expose no kit
// download, and the only pointer to it is make.fun/skill.md, which failed a
// security check and was not used. This program therefore reads a live public
// DefiLlama snapshot (data/snapshot.json, fetched 2026-11-24 from
// https://api.llama.fi/protocols) instead. The methodology is fully stated
// in dossier.json so the fallback is auditable.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import type { BoardRow } from "./vendor/makefun-board.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? ROOT;
const SNAPSHOT_PATH = process.env.SNAPSHOT ?? join(ROOT, "data", "snapshot.json");
const AS_OF = "2026-11-24";
const AS_OF_EPOCH = Date.parse(AS_OF + "T00:00:00Z") / 1000;
const ENTRANT = "jack-4 (Jack)";
const BOUNTY_ID = "token-radar-01";

interface RawProtocol {
  id?: string;
  name: string;
  address?: string | null;
  symbol?: string | null;
  url?: string;
  description?: string;
  chain?: string | null;
  logo?: string;
  audits?: number | string;
  gecko_id?: string | null;
  cmcId?: string | null;
  category?: string;
  chains?: string[];
  twitter?: string;
  listedAt?: number;
  tvl?: number;
  change_7d?: number | null;
  mcap?: number | null;
  slug?: string;
}

// ---------------------------------------------------------------------------
// Watchlist rules (all stated in dossier.json)
// ---------------------------------------------------------------------------
const MIN_TVL_USD = 1_000_000;
// Categories whose product IS a tradable receipt/wrapped token, or that cannot
// be farmed on-chain as a protocol (centralised exchanges, front-ends, chains).
const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Interface",
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Staking Pool",
  "Stablecoin Wrapper",
  "Chain",
]);
// Names that are themselves a traded asset (stablecoin / wrapped token),
// not a protocol whose launch you can farm.
const EXCLUDED_NAMES = new Set([
  "usdd", "wbtc", "usdt0", "cbbtc", "fbtc", "ebtc", "gtbtc", "solvbtc",
  "lbtc", "xbtc", "tbtc", "wsteth", "weeth", "reth", "cbeth", "lseth",
  "sfrxeth", "ankreth", "meth", "cmeth", "steth", "susde", "usde", "dai",
  "usds", "susds", "fdusd", "usdp", "tusd", "gusd", "pyusd", "usdx",
  "usdt", "usdc", "bittensor dtao", "lightning network",
  // Deployments / wrapped products of a protocol that already trades.
  "gmx solana", "stacks sbtc", "solvbtc lsts", "zircuit staking",
  "mantle restaking", "okx xbtc", "starknet btc staking", "gate sol",
  "rhea lst", "phantom sol", "nexus btc",
]);
// Curator/allocator TVL double-counts capital already counted in the
// underlying protocols, so their TVL is haircut before the peer multiple.
const CURATOR_CATEGORIES = new Set(["Risk Curators", "Onchain Capital Allocator"]);
const CURATOR_HAIRCUT = 0.25;
const MAX_IMPLIED_FDV_USD = 5_000_000_000;

const SUFFIXES = [
  " v1", " v2", " v3", " v4", " blue", " midnight", " earn", " lend",
  " perps", " bridge", " swap", " wallet", " international", " us",
  " combos", " seaport", " marketplace", " finance", " protocol", " app",
  " core", " prime", " labs", " network", " chain", " dex", " amm",
  " trade", " perpetual exchange", " perpetual", " staked sol",
  " staked eth", " liquid", " vaults", " vault", " curators", " curator",
  " asset management", " manager", " capital", " yield layer", " basis",
  " restaking", " staking",
];

function hasToken(p: RawProtocol): boolean {
  const sym = p.symbol;
  if (sym && sym !== "-") return true;
  if (p.address) return true;
  if (p.gecko_id) return true;
  if (p.mcap) return true;
  return false;
}

// The API returns audits as a string ("0", "2", "3") or null.
function auditCount(p: RawProtocol): number {
  if (typeof p.audits === "number") return p.audits;
  const n = parseInt(String(p.audits ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function stem(name: string): string {
  let s = " " + name.toLowerCase().trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return s.trim();
}

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "protocol";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function fmtUsd(x: number): string {
  if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
  return "$" + x.toFixed(0);
}

// Category-specific farm actions (step 2 and 3 of each 6-step plan).
const CATEGORY_ACTIONS: Record<string, [string, string]> = {
  Dexs: [
    "Swap a modest amount through {name} on {chain} once or twice a week, varying the pairs and sizes so the activity reads as real usage rather than a script.",
    "Provide a small amount of liquidity to one active {name} pool on {chain} and collect the fees instead of leaving the funds idle.",
  ],
  Lending: [
    "Supply collateral on {name} on {chain} and borrow a small amount against it, then repay part of it. A live borrow position counts more than a deposit alone.",
    "Use at least two different collateral assets on {name} over the month so the protocol records varied, sustained use.",
  ],
  Yield: [
    "Deposit into a {name} vault on {chain} and leave the position compounding. Reinvest the yield once rather than withdrawing it every week.",
    "Try a second {name} vault or strategy on a different chain so your activity is not tied to a single pool.",
  ],
  RWA: [
    "Buy or mint a small position in a tokenised asset on {name} on {chain} and hold it. Real-world-asset launches usually reward holders, not traders.",
    "Complete any identity or eligibility checks {name} asks for early, since RWA products often restrict rewards to verified users.",
  ],
  Derivatives: [
    "Open a small perpetual or options position on {name} on {chain}, close it at a small profit or loss, and repeat a few times a month with modest size.",
    "Keep your margin healthy and never use maximum leverage on {name}. A liquidation wipes out the farming position and the fees.",
  ],
  "Prediction Market": [
    "Place small trades on {name} on {chain} across several different markets instead of one big bet, and hold some positions through resolution.",
    "Provide liquidity to a {name} market if the option exists. Market makers are usually the best-rewarded participants.",
  ],
  Launchpad: [
    "Join a {name} sale or allocation round on {chain} with a small amount and hold the allocation through its vesting period.",
    "Check the {name} launch calendar weekly so you do not miss a round, and keep whatever stake the platform asks for to qualify.",
  ],
  CDP: [
    "Mint a small amount of stablecoin against collateral on {name} on {chain}, keep the collateral ratio well above the minimum, and repay before any market stress.",
    "Use the minted stablecoin in a {name}-supported pool rather than selling it outright, so the position stays productive.",
  ],
  "Yield Aggregator": [
    "Deposit into a {name} auto-compounding vault on {chain} and let it run. The compounding history is the activity that gets rewarded.",
    "Move a small share between two {name} vaults once a month to show active management without churning the position.",
  ],
  "Risk Curators": [
    "Deposit into a vault curated by {name} on {chain} and keep the deposit in place. Curator rewards, if any, usually go to vault depositors.",
    "Compare the curator vaults on {name} and pick one with a clear strategy and a public audit, rather than the highest advertised yield.",
  ],
  "Onchain Capital Allocator": [
    "Deposit into a vault allocated by {name} on {chain} and keep the deposit in place. Allocator rewards, if any, usually go to vault depositors.",
    "Compare the vaults on {name} and pick one with a clear strategy and a public audit, rather than the highest advertised yield.",
  ],
  "Basis Trading": [
    "Deposit into a {name} basis-trading vault on {chain} with a small amount and hold through at least one funding cycle.",
    "Read how {name} hedges its positions before depositing. A basis trade that is not hedged is just a leveraged bet.",
  ],
  Payments: [
    "Use {name} on {chain} for a few real payments each month, even small ones, so the protocol records you as an active user.",
    "If {name} offers a card or checkout, try one real purchase through it and keep the receipt as your own record.",
  ],
  Farm: [
    "Stake in a {name} farm on {chain} and harvest the rewards weekly, compounding half back into the same farm.",
    "Do not chase the highest-APR pool on {name}. Pick a pool with real liquidity and a history longer than a month.",
  ],
  "Liquidity Manager": [
    "Deposit into a {name} managed liquidity position on {chain} and leave it to rebalance. The manager's fees are the reward for patience.",
    "Check the position range on {name} once a week and top it up only if it has drifted out of range.",
  ],
  "Collateral Markets": [
    "Open a small collateralised position on {name} on {chain} and keep the health factor high. Restaking collateral can be slashed if the position is unhealthy.",
    "Restake only assets you can afford to lock on {name}, and read the slashing conditions before you deposit.",
  ],
  "CDP Manager": [
    "Use {name} on {chain} to manage a collateralised debt position, keeping the ratio safe and repaying a little each week.",
    "Automate a small repayment on {name} so the position stays healthy even if you forget to check it.",
  ],
};

const DEFAULT_ACTIONS: [string, string] = [
  "Use {name}'s core feature on {chain} at least once a week with a modest amount, varying what you do so the activity looks like a real user.",
  "Try a second feature or chain on {name} during the month so your footprint is broader than a single action.",
];

function fill(template: string, name: string, chain: string): string {
  return template.replaceAll("{name}", name).replaceAll("{chain}", chain);
}

function farmSteps(name: string, chain: string, category: string): string[] {
  const [a, b] = CATEGORY_ACTIONS[category] ?? DEFAULT_ACTIONS;
  return [
    `Set up a fresh wallet just for farming ${name} and fund it with a small test amount on ${chain} first. Never farm from the wallet that holds your main funds.`,
    fill(a, name, chain),
    fill(b, name, chain),
    `If ${name} runs a points, quests or leaderboard program, opt in and finish the listed tasks. Keep a weekly screenshot of your points balance as your own record.`,
    `Hold the position for at least a full month and do not withdraw everything right after a snapshot rumour. Launches usually reward duration, not just volume.`,
    `Watch ${name}'s official announcements for a token or points launch. If a token launches, check eligibility in the official app only and never sign a transaction from a link in a DM or an ad.`,
  ];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
interface Family {
  key: string;
  name: string;
  variants: string[];
  category: string;
  chain: string;
  chains: string[];
  tvl: number;
  change7d: number | null;
  audits: number;
  listedAt: number | null;
  url: string;
  description: string;
}

function buildBoard(): { rows: BoardRow[]; exclusions: { rule: string; removed: number }[]; peerMultiples: Record<string, { median: number; n: number }>; snapshotCount: number } {
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as RawProtocol[];
  const snapshotCount = raw.length;
  const exclusions: { rule: string; removed: number }[] = [];

  const tokenized = raw.filter((p) => hasToken(p));
  exclusions.push({ rule: "protocol already has a token (symbol, contract address, CoinGecko id or market cap present)", removed: tokenized.length });
  let pool = raw.filter((p) => !hasToken(p));

  const belowTvl = pool.filter((p) => (p.tvl ?? 0) < MIN_TVL_USD);
  exclusions.push({ rule: "TVL below $1M (no meaningful capital to farm)", removed: belowTvl.length });
  pool = pool.filter((p) => (p.tvl ?? 0) >= MIN_TVL_USD);

  const badCat = pool.filter((p) => EXCLUDED_CATEGORIES.has(p.category ?? ""));
  exclusions.push({ rule: "category is a wrapped/staked product, a centralised exchange, a front-end, a bridge or a chain itself", removed: badCat.length });
  pool = pool.filter((p) => !EXCLUDED_CATEGORIES.has(p.category ?? ""));

  const badName = pool.filter((p) => EXCLUDED_NAMES.has(p.name.trim().toLowerCase()));
  exclusions.push({ rule: "name is itself a traded asset (stablecoin or wrapped token)", removed: badName.length });
  pool = pool.filter((p) => !EXCLUDED_NAMES.has(p.name.trim().toLowerCase()));

  // Group version/variant rows into one protocol family.
  const families = new Map<string, Family>();
  for (const p of pool) {
    const key = stem(p.name);
    const tvl = p.tvl ?? 0;
    const existing = families.get(key);
    if (!existing) {
      families.set(key, {
        key,
        name: p.name,
        variants: [p.name],
        category: p.category ?? "Other",
        chain: p.chain ?? "Multi-Chain",
        chains: [...(p.chains ?? [])],
        tvl,
        change7d: p.change_7d ?? null,
        audits: auditCount(p),
        listedAt: p.listedAt ?? null,
        url: p.url ?? "",
        description: (p.description ?? "").trim(),
      });
    } else {
      existing.variants.push(p.name);
      existing.tvl += tvl;
      if (tvl > 0) {
        // The highest-TVL variant names the family and sets its category/chain.
        const prevTop = existing.tvl - tvl;
        if (tvl > prevTop) {
          existing.name = p.name;
          existing.category = p.category ?? existing.category;
          existing.chain = p.chain ?? existing.chain;
          existing.url = p.url ?? existing.url;
          existing.description = (p.description ?? "").trim() || existing.description;
        }
      }
      for (const c of p.chains ?? []) if (!existing.chains.includes(c)) existing.chains.push(c);
      existing.audits = Math.max(existing.audits, auditCount(p));
      if (p.listedAt && (!existing.listedAt || p.listedAt < existing.listedAt)) existing.listedAt = p.listedAt;
      if (p.change_7d != null && existing.change7d != null) {
        existing.change7d = (existing.change7d + p.change_7d) / 2;
      } else if (p.change_7d != null) {
        existing.change7d = p.change_7d;
      }
    }
  }
  const mergedCount = pool.length - families.size;
  exclusions.push({ rule: "version/variant rows merged into one family row", removed: mergedCount });

  // Peer multiples: median market-cap / TVL of tokenised protocols per category.
  const peerValues = new Map<string, number[]>();
  const globalValues: number[] = [];
  for (const p of tokenized) {
    const tvl = p.tvl ?? 0;
    const mcap = p.mcap ?? 0;
    if (tvl > 1_000_000 && mcap > 0) {
      const ratio = clamp(mcap / tvl, 0.02, 5);
      globalValues.push(ratio);
      const cat = p.category ?? "Other";
      if (!peerValues.has(cat)) peerValues.set(cat, []);
      peerValues.get(cat)!.push(ratio);
    }
  }
  const globalMedian = median(globalValues);
  const peerMultiples: Record<string, { median: number; n: number }> = {};
  for (const [cat, vals] of [...peerValues.entries()].sort()) {
    peerMultiples[cat] = { median: median(vals), n: vals.length };
  }

  const fams = [...families.values()];
  const rows: BoardRow[] = fams.map((f) => {
    const peer = (peerValues.get(f.category) ?? []).length >= 3
      ? { median: median(peerValues.get(f.category)!), n: peerValues.get(f.category)!.length }
      : { median: globalMedian, n: peerValues.get(f.category)?.length ?? 0 };
    const isCurator = CURATOR_CATEGORIES.has(f.category);
    const tvlForFdv = isCurator ? f.tvl * CURATOR_HAIRCUT : f.tvl;
    const impliedFdv = Math.min(tvlForFdv * peer.median, MAX_IMPLIED_FDV_USD);

    // Likelihood that this protocol launches a token and rewards farmers.
    let likelihood = 0.35;
    likelihood += 0.2 * clamp(Math.log10(Math.max(f.tvl, 1) / 1e6) / 3, 0, 1);
    if ((f.change7d ?? 0) > 0) likelihood += 0.05;
    if ((f.change7d ?? 0) > 20) likelihood += 0.05;
    if (f.audits >= 1) likelihood += 0.05;
    if (f.audits >= 2) likelihood += 0.05;
    if (f.chains.length >= 3) likelihood += 0.05;
    if (f.listedAt && AS_OF_EPOCH - f.listedAt >= 365 * 86400) likelihood += 0.05;
    if (["Dexs", "Lending", "Derivatives", "Yield", "RWA", "Prediction Market"].includes(f.category)) likelihood += 0.1;
    else if (["CDP", "Basis Trading", "Launchpad"].includes(f.category)) likelihood += 0.05;
    else if (isCurator) likelihood -= 0.1;
    likelihood = clamp(likelihood, 0.05, 0.95);

    const impliedValue = impliedFdv * likelihood;
    const verdict = impliedValue >= 100_000_000 ? "Top farm" : impliedValue >= 25_000_000 ? "Worth farming" : impliedValue >= 5_000_000 ? "Speculative" : "Watch only";
    const ageDays = f.listedAt ? Math.max(0, Math.floor((AS_OF_EPOCH - f.listedAt) / 86400)) : null;
    const reason =
      `TVL ${fmtUsd(f.tvl)}` +
      (isCurator ? " (curator TVL haircut 0.25x, capital is double-counted)" : "") +
      ` · ${f.category} peer multiple ${peer.median.toFixed(2)}x` +
      (peer.n < 3 ? " (global median, too few category peers)" : ` (n=${peer.n})`) +
      ` · launch likelihood ${Math.round(likelihood * 100)}%`;
    return {
      rank: 0,
      slug: slugOf(f.key),
      name: f.name,
      chain: f.chains.length > 3 ? "Multi-Chain" : f.chain,
      chains: [...f.chains].sort(),
      category: f.category,
      tvlUsd: Math.round(f.tvl),
      tvlChange7dPct: f.change7d == null ? null : Math.round(f.change7d * 100) / 100,
      audits: f.audits,
      listedAt: f.listedAt,
      ageDays,
      peerMultiple: Math.round(peer.median * 1000) / 1000,
      peerCount: peer.n,
      impliedFdvUsd: Math.round(impliedFdv),
      likelihood: Math.round(likelihood * 1000) / 1000,
      impliedValueUsd: Math.round(impliedValue),
      verdict,
      reason,
      farmSteps: farmSteps(f.name, f.chains.length > 3 ? "Multi-Chain" : f.chain, f.category),
      variants: [...new Set(f.variants)].sort(),
    };
  });

  rows.sort((a, b) => b.impliedValueUsd - a.impliedValueUsd);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { rows, exclusions, peerMultiples, snapshotCount };
}

// ---------------------------------------------------------------------------
// Dashboard (static, no network: no external resources, no web addresses at
// all in the file — the gate forbids naming a network address in dashboard/)
// ---------------------------------------------------------------------------
function sanitizeForDashboard(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/www\.\S+/g, "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&(?!(lt|gt|amp);)/g, "&amp;")
    .replace(/\s+/g, " ")
    .trim();
}

function dashboardHtml(rows: BoardRow[], rawBySlug: Map<string, RawProtocol>): string {
  const data = rows.map((r) => {
    const raw = rawBySlug.get(r.slug);
    return {
      rank: r.rank, slug: r.slug, name: r.name, chain: r.chain, chains: r.chains,
      category: r.category, tvl: r.tvlUsd, ch7: r.tvlChange7dPct, mult: r.peerMultiple,
      fdv: r.impliedFdvUsd, like: r.likelihood, value: r.impliedValueUsd,
      verdict: r.verdict, reason: sanitizeForDashboard(r.reason),
      steps: r.farmSteps.map((s) => sanitizeForDashboard(s)),
      audits: r.audits, age: r.ageDays,
      desc: sanitizeForDashboard(raw?.description ?? ""),
      variants: r.variants,
    };
  });
  const chains = [...new Set(rows.map((r) => r.chain))].sort();
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const totalTvl = rows.reduce((s, r) => s + r.tvlUsd, 0);
  const totalValue = rows.reduce((s, r) => s + r.impliedValueUsd, 0);
  const topValue = rows.length ? rows[0].impliedValueUsd : 0;

  const chainOptions = ["All chains", ...chains].map((c) => `<option value="${c === "All chains" ? "" : c}">${c}</option>`).join("");
  const catOptions = ["All categories", ...categories].map((c) => `<option value="${c === "All categories" ? "" : c}">${c}</option>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Launch Radar — tokenless protocols ranked by implied launch value</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#e8eef4}
header{padding:28px 28px 8px}h1{margin:0 0 6px;font-size:28px}header p{margin:4px 0;color:#9fb0c0;max-width:900px}
.stats{display:flex;gap:12px;flex-wrap:wrap;padding:14px 28px}.stat{background:#131b24;border:1px solid #22303e;border-radius:10px;padding:12px 16px;min-width:150px}
.stat b{display:block;font-size:20px}.stat span{color:#9fb0c0;font-size:12px}
.controls{display:flex;gap:10px;flex-wrap:wrap;padding:10px 28px;position:sticky;top:0;background:#0b0f14;z-index:5;border-bottom:1px solid #22303e}
.controls input,.controls select{background:#131b24;color:#e8eef4;border:1px solid #22303e;border-radius:8px;padding:8px 10px;font-size:14px}
.controls input{flex:1;min-width:180px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #1a2632;white-space:nowrap}
th{cursor:pointer;color:#9fb0c0;position:sticky;top:53px;background:#0b0f14}tbody tr{cursor:pointer}tbody tr:hover{background:#131b24}
td.num,th.num{text-align:right}.pos{color:#7ee2a8}.neg{color:#ff8a8a}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:600}
.top{background:#12351f;color:#7ee2a8}.worth{background:#1d2f45;color:#8fc3ff}.spec{background:#3a2f10;color:#ffd479}.watch{background:#2a2f36;color:#9fb0c0}
#drawer{position:fixed;top:0;right:0;width:min(480px,94vw);height:100%;background:#101820;border-left:1px solid #22303e;overflow-y:auto;padding:22px;display:none;z-index:10}
#drawer.open{display:block}#drawer h2{margin:0 0 4px;font-size:22px}#drawer .meta{color:#9fb0c0;font-size:13px;margin:6px 0}
#drawer ol{padding-left:20px}#drawer li{margin:10px 0;line-height:1.5}
.kv{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.kv div{background:#131b24;border-radius:8px;padding:10px}.kv b{display:block;font-size:16px}.kv span{color:#9fb0c0;font-size:12px}
.close{float:right;background:#22303e;color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer}
section{padding:18px 28px;color:#c4d2de;line-height:1.6}section h2{color:#e8eef4;font-size:18px}
footer{padding:18px 28px 40px;color:#7c8b9a;font-size:12px;line-height:1.6}
.count{padding:8px 28px;color:#9fb0c0;font-size:13px}
</style></head><body>
<header><h1>Token Launch Radar</h1>
<p>Every tokenless protocol DefiLlama tracks, ranked by what its token launch would be worth. Implied value = TVL &times; the median market-cap / TVL of tokenised peers in the same category &times; a launch-likelihood score. One row per protocol family; wrapped, staked, centralised-exchange and bridge products are excluded.</p>
<p>Snapshot: live DefiLlama data, ${AS_OF}. Sealed kit snapshot was not obtainable (see methodology) — this board is built from the public snapshot instead, with the method stated in full.</p></header>
<div class="stats">
<div class="stat"><b>${rows.length}</b><span>protocols on the watchlist</span></div>
<div class="stat"><b>${fmtUsd(totalTvl)}</b><span>combined TVL tracked</span></div>
<div class="stat"><b>${fmtUsd(totalValue)}</b><span>combined implied launch value</span></div>
<div class="stat"><b>${fmtUsd(topValue)}</b><span>highest implied value (rank 1)</span></div>
</div>
<div class="controls">
<input id="q" type="search" placeholder="Search a protocol...">
<select id="chain">${chainOptions}</select>
<select id="category">${catOptions}</select>
<select id="verdict"><option value="">All verdicts</option><option>Top farm</option><option>Worth farming</option><option>Speculative</option><option>Watch only</option></select>
<select id="minValue"><option value="0">Any implied value</option><option value="100000000">&ge; $100M</option><option value="25000000">&ge; $25M</option><option value="5000000">&ge; $5M</option><option value="1000000">&ge; $1M</option></select>
<select id="sort"><option value="value">Sort: implied value</option><option value="tvl">Sort: TVL</option><option value="like">Sort: likelihood</option><option value="name">Sort: name A-Z</option></select>
</div>
<div class="count" id="count"></div>
<table><thead><tr>
<th>#</th><th>Protocol</th><th>Chain</th><th>Category</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Peer &times;</th><th class="num">Implied FDV</th><th class="num">Likelihood</th><th class="num">Implied value</th><th>Verdict</th>
</tr></thead><tbody id="body"></tbody></table>
<section><h2>How the ranking works</h2>
<p>1. Start from every protocol in the snapshot (9,100). 2. Keep only those with no token: no symbol, no contract address, no CoinGecko id and no market cap. 3. Drop TVL under $1M, and drop categories whose product is itself a tradable token (liquid staking, bridges, wrapped assets), centralised exchanges, front-ends and chains. 4. Merge version rows into one family (for example, a V2 and a V3 entry become one row). 5. Implied FDV = TVL &times; the median market-cap / TVL of tokenised peers in the same category (global median where a category has fewer than three peers), capped at $5B. Curator and allocator TVL is haircut 25% because it double-counts capital already counted in the underlying protocols. 6. Likelihood (5%&ndash;95%) scores size, 7-day TVL growth, audits, multi-chain presence, age and the category's token-launch precedent. 7. Implied value = implied FDV &times; likelihood. The board is sorted by implied value.</p>
<h2>What this radar cannot see</h2>
<p>DefiLlama TVL misses products with no on-chain TVL: wallets, social apps and marketplaces (their launches may be large, but there is no TVL to anchor a number to). Market cap here is circulating market cap, a conservative stand-in for fully diluted value. A high implied value is not a promise of an airdrop — no protocol on this board has announced a token. Farm with small amounts, use a fresh wallet, and never sign a transaction from a link in a DM or an ad.</p></section>
<aside id="drawer" aria-label="Protocol detail"></aside>
<footer>Token Launch Radar · built from the public DefiLlama snapshot of ${AS_OF} · entry for make.fun bounty token-radar-01 · not financial advice</footer>
<script>
var BOARD = __BOARD_JSON__;
var body = document.getElementById('body');
var drawer = document.getElementById('drawer');
function money(x){ if(x>=1e9) return '$'+(x/1e9).toFixed(2)+'B'; if(x>=1e6) return '$'+(x/1e6).toFixed(1)+'M'; if(x>=1e3) return '$'+(x/1e3).toFixed(1)+'K'; return '$'+x.toFixed(0); }
function badge(v){ return v==='Top farm' ? 'top' : v==='Worth farming' ? 'worth' : v==='Speculative' ? 'spec' : 'watch'; }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function filtered(){
  var q = document.getElementById('q').value.toLowerCase();
  var chain = document.getElementById('chain').value;
  var cat = document.getElementById('category').value;
  var ver = document.getElementById('verdict').value;
  var minV = Number(document.getElementById('minValue').value);
  var sort = document.getElementById('sort').value;
  var list = BOARD.filter(function(r){
    return (!q || r.name.toLowerCase().indexOf(q) >= 0 || r.slug.indexOf(q) >= 0)
      && (!chain || r.chain === chain || r.chains.indexOf(chain) >= 0)
      && (!cat || r.category === cat) && (!ver || r.verdict === ver) && r.value >= minV;
  });
  if (sort === 'tvl') list.sort(function(a,b){ return b.tvl - a.tvl; });
  else if (sort === 'like') list.sort(function(a,b){ return b.like - a.like; });
  else if (sort === 'name') list.sort(function(a,b){ return a.name.localeCompare(b.name); });
  else list.sort(function(a,b){ return b.value - a.value; });
  return list;
}
function render(){
  var list = filtered();
  document.getElementById('count').textContent = list.length + ' of ' + BOARD.length + ' protocols shown';
  var html = '';
  list.forEach(function(r){
    var ch = r.ch7 === null ? '&mdash;' : (r.ch7 > 0 ? '+' : '') + r.ch7.toFixed(1) + '%';
    var cls = r.ch7 === null ? '' : (r.ch7 > 0 ? 'pos' : 'neg');
    html += '<tr data-slug="' + r.slug + '"><td>' + r.rank + '</td><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.chain) + '</td><td>' + esc(r.category) + '</td><td class="num">' + money(r.tvl) + '</td><td class="num ' + cls + '">' + ch + '</td><td class="num">' + r.mult.toFixed(2) + 'x</td><td class="num">' + money(r.fdv) + '</td><td class="num">' + Math.round(r.like * 100) + '%</td><td class="num"><b>' + money(r.value) + '</b></td><td><span class="badge ' + badge(r.verdict) + '">' + r.verdict + '</span></td></tr>';
  });
  body.innerHTML = html;
}
function openDetail(slug){
  var r = null;
  for (var i = 0; i < BOARD.length; i++) if (BOARD[i].slug === slug) r = BOARD[i];
  if (!r) return;
  var steps = r.steps.map(function(s){ return '<li>' + esc(s) + '</li>'; }).join('');
  drawer.innerHTML = '<button class="close" onclick="closeDetail()">Close</button><h2>' + esc(r.name) + '</h2>'
    + '<p class="meta">Rank #' + r.rank + ' · ' + esc(r.category) + ' · ' + esc(r.chain) + ' · ' + esc(r.verdict) + '</p>'
    + '<p>' + esc(r.desc || 'No description in the snapshot.') + '</p>'
    + '<div class="kv"><div><b>' + money(r.tvl) + '</b><span>TVL</span></div><div><b>' + money(r.fdv) + '</b><span>Implied FDV</span></div>'
    + '<div><b>' + Math.round(r.like * 100) + '%</b><span>Launch likelihood</span></div><div><b>' + money(r.value) + '</b><span>Implied value</span></div>'
    + '<div><b>' + r.mult.toFixed(2) + 'x</b><span>Peer multiple</span></div><div><b>' + (r.audits || 0) + '</b><span>Audits</span></div></div>'
    + '<p class="meta">' + esc(r.reason) + '</p>'
    + '<p class="meta">Chains: ' + esc(r.chains.join(', ') || r.chain) + (r.variants.length > 1 ? ' · Snapshot rows merged: ' + esc(r.variants.join(', ')) : '') + (r.age !== null ? ' · Listed ' + r.age + ' days ago' : '') + '</p>'
    + '<h3>Farm plan</h3><ol>' + steps + '</ol>'
    + '<p class="meta">Risks: no token has been announced; smart-contract risk; airdrop criteria are never published in advance. Farm with small amounts only.</p>';
  drawer.classList.add('open');
  try { history.replaceState(null, '', '#detail=' + slug); } catch (e) {}
}
function closeDetail(){ drawer.classList.remove('open'); try { history.replaceState(null, '', location.pathname); } catch (e) {} }
body.addEventListener('click', function(e){ var tr = e.target.closest('tr'); if (tr) openDetail(tr.getAttribute('data-slug')); });
['q','chain','category','verdict','minValue','sort'].forEach(function(id){ document.getElementById(id).addEventListener('input', render); });
render();
function applyHash(){
  var h = location.hash || '';
  var m = h.match(/detail=([^&]+)/); if (m) openDetail(decodeURIComponent(m[1]));
  var c = h.match(/chain=([^&]+)/); if (c) { document.getElementById('chain').value = decodeURIComponent(c[1]); render(); }
  var f = h.match(/category=([^&]+)/); if (f) { document.getElementById('category').value = decodeURIComponent(f[1]); render(); }
}
window.addEventListener('hashchange', applyHash);
applyHash();
</script></body></html>`;
  return html.replace("__BOARD_JSON__", JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function main(): void {
  const { rows, exclusions, peerMultiples, snapshotCount } = buildBoard();
  const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as RawProtocol[];
  const rawBySlug = new Map<string, RawProtocol>();
  for (const p of raw) {
    const s = slugOf(stem(p.name));
    if (!rawBySlug.has(s)) rawBySlug.set(s, p);
  }

  const boardJson = rows.map((r) => {
    const rawRow = rawBySlug.get(r.slug);
    return {
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      chain: r.chain,
      chains: r.chains,
      category: r.category,
      tvlUsd: r.tvlUsd,
      tvlChange7dPct: r.tvlChange7dPct,
      audits: r.audits,
      listedAt: r.listedAt,
      ageDays: r.ageDays,
      peerMultiple: r.peerMultiple,
      peerCount: r.peerCount,
      impliedFdvUsd: r.impliedFdvUsd,
      likelihood: r.likelihood,
      impliedValueUsd: r.impliedValueUsd,
      verdict: r.verdict,
      reason: r.reason,
      farmSteps: r.farmSteps,
      variants: r.variants,
      url: rawRow?.url ?? "",
      description: (rawRow?.description ?? "").trim(),
      source: "DefiLlama public snapshot 2026-11-24 (fallback; sealed kit snapshot unavailable)",
    };
  });

  mkdirSync(join(OUT_DIR, "dashboard"), { recursive: true });
  mkdirSync(join(OUT_DIR, "screenshots"), { recursive: true });

  const boardText = JSON.stringify(boardJson, null, 2) + "\n";
  writeFileSync(join(OUT_DIR, "board.json"), boardText);

  const html = dashboardHtml(rows, rawBySlug);
  writeFileSync(join(OUT_DIR, "dashboard", "index.html"), html);

  const dashboardFiles = readdirSync(join(OUT_DIR, "dashboard"))
    .map((f) => ({ path: "dashboard/" + f, bytes: statSync(join(OUT_DIR, "dashboard", f)).size }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const screenshots = readdirSync(join(OUT_DIR, "screenshots"))
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .map((f) => {
      const buf = readFileSync(join(OUT_DIR, "screenshots", f));
      return { path: "screenshots/" + f, bytes: buf.length, sha256: sha256(buf) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const dossier = buildDossier({
    bountyId: BOUNTY_ID,
    title: "Token Launch Radar — tokenless protocols ranked by implied launch value",
    entrant: ENTRANT,
    snapshotSource: "https://api.llama.fi/protocols (public DefiLlama API)",
    snapshotFetchedAt: AS_OF,
    snapshotProtocols: snapshotCount,
    watchlistDefinition:
      "Tokenless protocols in the snapshot (no symbol, no contract address, no CoinGecko id, no market cap) with TVL >= $1M, excluding categories whose product is itself a tradable token (liquid staking/restaking, staking pools, bridges, wrapped assets), centralised exchanges, front-ends and chains, and excluding names that are themselves a traded asset; version rows merged into one family row.",
    exclusions,
    methodology:
      "Implied FDV = TVL x median market-cap/TVL of tokenised peers in the same category (global median where a category has fewer than 3 peers), winsorised to [0.02, 5], capped at $5B; curator/allocator TVL haircut 0.25x for double-counting. Likelihood (5%-95%) scores log TVL size, 7-day TVL growth, audits, multi-chain presence, age >= 1 year and category token-launch precedent. Implied value = implied FDV x likelihood; board sorted by implied value descending. Market cap is circulating market cap, a conservative stand-in for fully diluted value.",
    rankingFormula: "impliedValueUsd = min(TVL * curatorHaircut * peerMultiple, 5e9) * likelihood",
    peerMultiples,
    rows,
    dashboardFiles,
    screenshots,
    limitations: [
      "Sealed kit snapshot and official vendor/makefun-board.ts were not obtainable without make.fun/skill.md, which failed a security check and was not used; this build uses the live public DefiLlama snapshot of 2026-11-24 and a from-scratch reimplementation of buildDossier. Re-run the official kit before submitting.",
      "DefiLlama TVL misses products with no on-chain TVL (wallets, social apps, marketplaces); their launches may be large but cannot be anchored to a TVL number here.",
      "Prediction markets and similar businesses are systematically undervalued by a TVL multiple: their TVL is collateral, not business value.",
      "Market cap is circulating market cap, not fully diluted value, so implied FDVs are conservative.",
      "Screenshots were taken with the local headless Chromium and committed with the entry; main.ts verifies their presence and hashes them into dossier.json but does not take screenshots itself (no browser in a plain Node run).",
      "A few snapshot rows look like data-quality outliers (for example a large TVL on the obscure Anubis chain, and listing dates in the future); they are kept as reported rather than deleted, since there is no objective rule to exclude them.",
      "No protocol on this board has announced a token; implied value is an estimate, not a promise of an airdrop.",
    ],
    reproducibility:
      "node main.ts (Node 22.18+, no dependencies, no network). Reads data/snapshot.json, writes board.json, dashboard/index.html and dossier.json. Outputs are deterministic given the same snapshot: no wall-clock timestamps are used; the as-of date is the snapshot date. Screenshots: scripts/screenshot.sh with the headless Chromium in the animation toolchain.",
  });
  writeFileSync(join(OUT_DIR, "dossier.json"), JSON.stringify(dossier, null, 2) + "\n");

  const issues = dossier.validation.issues;
  console.log(`snapshot protocols: ${snapshotCount}`);
  console.log(`watchlist rows: ${rows.length}`);
  console.log(`top row: ${rows[0]?.name} — implied value ${fmtUsd(rows[0]?.impliedValueUsd ?? 0)}`);
  console.log(`dashboard: ${dashboardFiles.length} file(s), ${dashboardFiles.reduce((s, f) => s + f.bytes, 0)} bytes`);
  console.log(`screenshots: ${screenshots.length}`);
  console.log(`validation: ${issues.length === 0 ? "PASS" : "FAIL — " + issues.slice(0, 10).join("; ")}`);
}

main();
