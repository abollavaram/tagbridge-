/**
 * Runs Lighthouse (mobile preset) against a running server and checks the
 * thresholds the spec sets. Exits non-zero if any page misses one, so it can
 * gate a build.
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
      const out = path.join(dir, `${page.name}.json`);
      await runLighthouse(`${BASE}${page.path}`, out);
      const report = JSON.parse(readFileSync(out, 'utf8')) as Report;

      const scores = {
        performance: pct(report.categories.performance?.score ?? null),
        accessibility: pct(report.categories.accessibility?.score ?? null),
        'best-practices': pct(report.categories['best-practices']?.score ?? null),
        seo: pct(report.categories.seo?.score ?? null),
      };
      const lcp = Math.round(report.audits['largest-contentful-paint']?.numericValue ?? 0);
      const cls = Number((report.audits['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3));
      const tbt = Math.round(report.audits['total-blocking-time']?.numericValue ?? 0);

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

  console.log(`\nLighthouse (mobile preset) against ${BASE}\n`);
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
