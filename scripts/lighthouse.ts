/**
 * Runs Lighthouse (mobile preset) against a running server and checks the
 * thresholds the spec sets. Exits non-zero if any page misses one, so it can
 * gate a build.
 *
 * Each page is warmed with a plain request and then measured several times,
 * reporting the median of each metric. Lab metrics — total blocking time
 * especially — are noisy on a shared two-core CI runner: the first page
 * measured after the server boots once read 356 ms against 73 ms for a heavier
 * page in the same run. Medians make the gate reflect the page rather than the
 * runner, without moving the thresholds.
 *
 * Usage: pnpm lighthouse [baseUrl]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] ?? process.env.LH_BASE_URL ?? 'http://127.0.0.1:3100';

const PAGES = [
  { name: 'Home', path: '/' },
  { name: 'Catalog', path: '/products' },
  { name: 'Product', path: '/products/meridian-opc-ua-server-allen-bradley' },
];

const THRESHOLDS = {
  performance: 90,
  accessibility: 95,
  'best-practices': 95,
  seo: 95,
} as const;

const VITALS = { lcp: 2500, cls: 0.1, tbt: 200 };

/** Lighthouse CI aggregates repeated runs the same way. */
const RUNS = Math.max(1, Number(process.env.LH_RUNS ?? 3));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

interface Measured {
  performance: number;
  accessibility: number;
  'best-practices': number;
  seo: number;
  lcp: number;
  cls: number;
  tbt: number;
}

async function warmUp(url: string): Promise<void> {
  try {
    await fetch(url, { cache: 'no-store' });
  } catch {
    // The run itself will report an unreachable server far more clearly.
  }
}

interface Report {
  categories: Record<string, { score: number | null }>;
  audits: Record<string, { numericValue?: number }>;
}

function runLighthouse(url: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join('node_modules', 'lighthouse', 'cli', 'index.js'),
        url,
        '--quiet',
        '--output=json',
        `--output-path=${outFile}`,
        '--only-categories=performance,accessibility,best-practices,seo',
        '--chrome-flags=--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage',
      ],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          CHROME_PATH: process.env.CHROME_PATH ?? process.env.LH_CHROME_PATH ?? '',
        },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`lighthouse exited ${code}`)),
    );
  });
}

function pct(score: number | null): number {
  return Math.round((score ?? 0) * 100);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lh-'));
  const rows: string[] = [];
  let failed = false;

  try {
    for (const page of PAGES) {
      const url = `${BASE}${page.path}`;
      await warmUp(url);

      const runs: Measured[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const out = path.join(dir, `${page.name}-${run}.json`);
        await runLighthouse(url, out);
        const report = JSON.parse(readFileSync(out, 'utf8')) as Report;
        runs.push({
          performance: pct(report.categories.performance?.score ?? null),
          accessibility: pct(report.categories.accessibility?.score ?? null),
          'best-practices': pct(report.categories['best-practices']?.score ?? null),
          seo: pct(report.categories.seo?.score ?? null),
          lcp: Math.round(report.audits['largest-contentful-paint']?.numericValue ?? 0),
          cls: report.audits['cumulative-layout-shift']?.numericValue ?? 0,
          tbt: Math.round(report.audits['total-blocking-time']?.numericValue ?? 0),
        });
      }

      const scores = {
        performance: Math.round(median(runs.map((r) => r.performance))),
        accessibility: Math.round(median(runs.map((r) => r.accessibility))),
        'best-practices': Math.round(median(runs.map((r) => r['best-practices']))),
        seo: Math.round(median(runs.map((r) => r.seo))),
      };
      const lcp = Math.round(median(runs.map((r) => r.lcp)));
      const cls = Number(median(runs.map((r) => r.cls)).toFixed(3));
      const tbt = Math.round(median(runs.map((r) => r.tbt)));

      for (const [key, min] of Object.entries(THRESHOLDS)) {
        const value = scores[key as keyof typeof scores];
        if (value < min) {
          failed = true;
          console.error(`FAIL ${page.name}: ${key} ${value} < ${min}`);
        }
      }
      if (lcp > VITALS.lcp) {
        failed = true;
        console.error(`FAIL ${page.name}: LCP ${lcp}ms > ${VITALS.lcp}ms`);
      }
      if (cls > VITALS.cls) {
        failed = true;
        console.error(`FAIL ${page.name}: CLS ${cls} > ${VITALS.cls}`);
      }
      if (tbt > VITALS.tbt) {
        failed = true;
        console.error(`FAIL ${page.name}: TBT ${tbt}ms > ${VITALS.tbt}ms`);
      }

      rows.push(
        `| ${page.name} | ${scores.performance} | ${scores.accessibility} | ` +
          `${scores['best-practices']} | ${scores.seo} | ${lcp} ms | ${cls} | ${tbt} ms |`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    `\nLighthouse (mobile preset) against ${BASE} — median of ${RUNS} run${RUNS === 1 ? '' : 's'}\n`,
  );
  console.log('| Page | Perf | A11y | Best Prac. | SEO | LCP | CLS | TBT |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of rows) console.log(row);
  console.log(
    '\nTBT is the lab proxy for INP; Lighthouse does not measure INP without field data.',
  );

  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
