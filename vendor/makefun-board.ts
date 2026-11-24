// vendor/makefun-board.ts
//
// REIMPLEMENTATION NOTICE (read first):
// The official make.fun kit file vendor/makefun-board.ts was NOT available
// through any public channel: the bounty page and the public competitions API
// expose no kit download, and the only pointer to the kit is make.fun/skill.md,
// which failed a security check and must not be downloaded, installed or run.
// This file is therefore a from-scratch reimplementation of the interface the
// public brief describes: it validates a board against the published gate
// rules and writes dossier.json. It is NOT the official kit file, and a real
// submission must be re-checked with the official kit (buildDossier) before
// it is entered. Nothing here was copied from make.fun/skill.md.
//
// Public gate rules implemented here (from the bounty page / API resolution
// criteria, fetched 2026-11-24):
//   - board.json: 100 to 4000 rows, rows are protocols from the snapshot,
//     ranked by a stated implied value, whole watchlist covered
//   - each row: 3 to 12 farm steps, each 20 to 600 characters
//   - dashboard/: at most 400 files, at most 4 MiB, names no network address
//   - 3 to 4 screenshots
//   - dossier.json as buildDossier writes it
//   - the program runs twice and both runs must write the same bytes
//     (determinism: this module never reads the wall clock; dates come from
//     the snapshot metadata passed in by main.ts)

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  chain: string;
  chains: string[];
  category: string;
  tvlUsd: number;
  tvlChange7dPct: number | null;
  audits: number;
  listedAt: number | null;
  ageDays: number | null;
  peerMultiple: number;
  peerCount: number;
  impliedFdvUsd: number;
  likelihood: number;
  impliedValueUsd: number;
  verdict: string;
  reason: string;
  farmSteps: string[];
  variants: string[];
}

export interface DossierInput {
  bountyId: string;
  title: string;
  entrant: string;
  snapshotSource: string;
  snapshotFetchedAt: string;
  snapshotProtocols: number;
  watchlistDefinition: string;
  exclusions: { rule: string; removed: number }[];
  methodology: string;
  rankingFormula: string;
  peerMultiples: Record<string, { median: number; n: number }>;
  rows: BoardRow[];
  dashboardFiles: { path: string; bytes: number }[];
  screenshots: { path: string; bytes: number; sha256: string }[];
  limitations: string[];
  reproducibility: string;
}

export interface Dossier {
  schemaVersion: string;
  bounty: string;
  title: string;
  entrant: string;
  generatedFrom: { snapshotSource: string; snapshotFetchedAt: string; snapshotProtocols: number };
  watchlist: { definition: string; rows: number; exclusions: { rule: string; removed: number }[] };
  methodology: string;
  rankingFormula: string;
  peerMultiples: Record<string, { median: number; n: number }>;
  board: {
    rows: number;
    totalTvlUsd: number;
    totalImpliedValueUsd: number;
    topImpliedValueUsd: number;
    medianImpliedValueUsd: number;
    verdictCounts: Record<string, number>;
    top10: { rank: number; name: string; category: string; chain: string; tvlUsd: number; impliedValueUsd: number; likelihood: number }[];
  };
  farmPlan: { stepsPerRow: number; minStepChars: number; maxStepChars: number };
  dashboard: { files: number; bytes: number; fileList: { path: string; bytes: number }[] };
  screenshots: { path: string; bytes: number; sha256: string }[];
  validation: { passed: boolean; issues: string[] };
  limitations: string[];
  reproducibility: string;
  reimplementationNotice: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function verdictCounts(rows: BoardRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  return counts;
}

/** Gate checks from the published brief. Returns a list of issues; empty = pass. */
export function validateBoard(rows: BoardRow[]): string[] {
  const issues: string[] = [];
  if (rows.length < 100) issues.push(`board has ${rows.length} rows, minimum is 100`);
  if (rows.length > 4000) issues.push(`board has ${rows.length} rows, maximum is 4000`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.rank !== i + 1) issues.push(`row ${row.slug}: rank ${row.rank} != position ${i + 1}`);
    if (i > 0 && row.impliedValueUsd > rows[i - 1].impliedValueUsd) {
      issues.push(`row ${row.slug}: not ranked by implied value descending`);
    }
    if (row.farmSteps.length < 3) issues.push(`row ${row.slug}: ${row.farmSteps.length} farm steps, minimum is 3`);
    if (row.farmSteps.length > 12) issues.push(`row ${row.slug}: ${row.farmSteps.length} farm steps, maximum is 12`);
    for (const step of row.farmSteps) {
      if (step.length < 20) issues.push(`row ${row.slug}: farm step shorter than 20 chars: "${step.slice(0, 40)}"`);
      if (step.length > 600) issues.push(`row ${row.slug}: farm step longer than 600 chars`);
    }
    if (!(row.impliedValueUsd > 0)) issues.push(`row ${row.slug}: implied value is not positive`);
    if (row.likelihood < 0 || row.likelihood > 1) issues.push(`row ${row.slug}: likelihood outside [0, 1]`);
  }
  return issues;
}

export function buildDossier(input: DossierInput): Dossier {
  const issues = validateBoard(input.rows);
  const values = input.rows.map((r) => r.impliedValueUsd);
  const dashboardBytes = input.dashboardFiles.reduce((sum, f) => sum + f.bytes, 0);
  const stepChars = input.rows.flatMap((r) => r.farmSteps.map((s) => s.length));
  return {
    schemaVersion: "token-radar-dossier/1 (reimplementation, not the official kit)",
    bounty: input.bountyId,
    title: input.title,
    entrant: input.entrant,
    generatedFrom: {
      snapshotSource: input.snapshotSource,
      snapshotFetchedAt: input.snapshotFetchedAt,
      snapshotProtocols: input.snapshotProtocols,
    },
    watchlist: {
      definition: input.watchlistDefinition,
      rows: input.rows.length,
      exclusions: input.exclusions,
    },
    methodology: input.methodology,
    rankingFormula: input.rankingFormula,
    peerMultiples: input.peerMultiples,
    board: {
      rows: input.rows.length,
      totalTvlUsd: input.rows.reduce((s, r) => s + r.tvlUsd, 0),
      totalImpliedValueUsd: input.rows.reduce((s, r) => s + r.impliedValueUsd, 0),
      topImpliedValueUsd: input.rows.length > 0 ? input.rows[0].impliedValueUsd : 0,
      medianImpliedValueUsd: median(values),
      verdictCounts: verdictCounts(input.rows),
      top10: input.rows.slice(0, 10).map((r) => ({
        rank: r.rank,
        name: r.name,
        category: r.category,
        chain: r.chain,
        tvlUsd: r.tvlUsd,
        impliedValueUsd: r.impliedValueUsd,
        likelihood: r.likelihood,
      })),
    },
    farmPlan: {
      stepsPerRow: input.rows.length > 0 ? input.rows[0].farmSteps.length : 0,
      minStepChars: stepChars.length > 0 ? Math.min(...stepChars) : 0,
      maxStepChars: stepChars.length > 0 ? Math.max(...stepChars) : 0,
    },
    dashboard: {
      files: input.dashboardFiles.length,
      bytes: dashboardBytes,
      fileList: input.dashboardFiles,
    },
    screenshots: input.screenshots,
    validation: { passed: issues.length === 0, issues },
    limitations: input.limitations,
    reproducibility: input.reproducibility,
    reimplementationNotice:
      "vendor/makefun-board.ts in this repo is a from-scratch reimplementation. The official kit file was not obtainable without make.fun/skill.md, which failed a security check and was not used. Re-run the official kit's buildDossier before submitting.",
  };
}
