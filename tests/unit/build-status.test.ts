import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEASURED, PHASES, PHASES_SHIPPED, PHASES_TOTAL } from '@/lib/build-status';

/**
 * Guards against the site describing an older version of itself.
 *
 * A hardcoded "Phase 2" sat on the home page for three phases after it stopped
 * being true, and several pages promised features that had already shipped.
 * Nobody re-reads copy, so the check has to be automatic: no page may name a
 * phase number in prose, and no page may promise something as arriving.
 */

const APP = path.join(process.cwd(), 'app');

function pageFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.tsx')) found.push(full);
    }
  };
  walk(APP);
  return found;
}

/** Strips comments, so a note to a developer is not read as page copy. */
function visibleSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the phase list', () => {
  it('has every phase the spec defines', () => {
    expect(PHASES_TOTAL).toBe(6);
    expect(PHASES.map((p) => p.number)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('counts only what shipped', () => {
    expect(PHASES_SHIPPED).toBe(PHASES.filter((p) => p.shipped).length);
  });

  it('gives every shipped phase somewhere a visitor can go and look', () => {
    for (const phase of PHASES) {
      if (!phase.shipped) continue;
      expect(phase.proof, phase.name).toMatch(/^\//);
    }
  });
});

describe('measured figures are plausible and stated as measured', () => {
  it('search precision is a probability', () => {
    expect(MEASURED.searchPrecisionAt3).toBeGreaterThan(0);
    expect(MEASURED.searchPrecisionAt3).toBeLessThanOrEqual(1);
  });

  it('the guardrail hold rate is the only figure allowed to be 1.0', () => {
    // Everything else is a quality measure that moves; this one is pass/fail.
    expect(MEASURED.guardrailHoldRate).toBe(1);
    expect(MEASURED.searchPrecisionAt3).toBeLessThan(1);
  });

  it('names how many queries the search figure covers', () => {
    expect(MEASURED.searchQueries).toBe(100);
  });
});

describe('no page describes an older version of the site', () => {
  const files = pageFiles();

  it('finds pages to check', () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it('names no phase number in visible copy', () => {
    const offenders = files.filter((file) => /phase\s*\d/i.test(visibleSource(file)));
    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      'a phase number in page copy goes stale the moment the next phase ships',
    ).toEqual([]);
  });

  it('promises nothing as arriving or landing later', () => {
    const offenders = files.filter((file) =>
      /\b(arrives in|lands? in|coming in|will arrive|not yet built)\b/i.test(visibleSource(file)),
    );
    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      'copy promising a future feature outlives the feature being built',
    ).toEqual([]);
  });
});

describe('the README agrees with the code', () => {
  const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

  it('does not still claim phases 0 to 2', () => {
    expect(readme).not.toMatch(/phases 0, 1 and 2 of 5 complete/i);
  });

  it('publishes the same precision figure the code reports', () => {
    expect(readme).toContain(MEASURED.searchPrecisionAt3.toFixed(2));
  });

  it('says which phases are complete', () => {
    expect(readme).toMatch(/all 5 phases complete/i);
  });
});
