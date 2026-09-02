import { describe, expect, it } from 'vitest';
import type { QuoteStatus } from '@/lib/db/schema';
import {
  allowedNextStates,
  approvalThresholdCents,
  assertTransition,
  DEFAULT_APPROVAL_THRESHOLD_CENTS,
  isTerminal,
  QUOTE_STATUSES,
  QuoteTransitionError,
  requiresApproval,
  stateAfterSubmit,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type TransitionContext,
} from '@/lib/commerce/quote-state';

const OWNER: TransitionContext = { isOwner: true, isApprover: false, isSystem: false };
const APPROVER: TransitionContext = { isOwner: false, isApprover: true, isSystem: false };
const SYSTEM: TransitionContext = { isOwner: false, isApprover: false, isSystem: true };
const STRANGER: TransitionContext = { isOwner: false, isApprover: false, isSystem: false };

const ALL: QuoteStatus[] = [...QUOTE_STATUSES];

/** The permissive context, used to test edge existence separately from authz. */
const ANYONE: TransitionContext = { isOwner: true, isApprover: true, isSystem: true };

describe('the legal path through a quote', () => {
  it('walks draft to converted', () => {
    const path: [QuoteStatus, QuoteStatus][] = [
      ['draft', 'pending_approval'],
      ['pending_approval', 'sent'],
      ['sent', 'viewed'],
      ['viewed', 'accepted'],
      ['accepted', 'converted'],
    ];
    for (const [from, to] of path) {
      expect(() => assertTransition(from, to, ANYONE), `${from}->${to}`).not.toThrow();
    }
  });

  it('lets a quote expire from any live sent state', () => {
    for (const from of ['sent', 'viewed', 'accepted'] as QuoteStatus[]) {
      expect(() => assertTransition(from, 'expired', SYSTEM), from).not.toThrow();
    }
  });

  it('lets a buyer reject from sent or viewed', () => {
    expect(() => assertTransition('sent', 'rejected', OWNER)).not.toThrow();
    expect(() => assertTransition('viewed', 'rejected', OWNER)).not.toThrow();
  });

  it('lets an approver send a quote back to draft for rework', () => {
    expect(() => assertTransition('pending_approval', 'draft', APPROVER)).not.toThrow();
  });
});

describe('every illegal edge throws', () => {
  it('rejects every pair that is not declared, exhaustively', () => {
    const legal = new Set(TRANSITIONS.map((t) => `${t.from}->${t.to}`));
    let checked = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) continue;
        if (legal.has(`${from}->${to}`)) continue;
        checked += 1;
        expect(
          () => assertTransition(from, to, ANYONE),
          `${from} -> ${to} should be illegal`,
        ).toThrow(QuoteTransitionError);
      }
    }
    // 8 states, 56 ordered pairs, 15 legal — the rest must all throw.
    expect(checked).toBe(56 - TRANSITIONS.length);
  });

  it('refuses the specific jumps that would matter commercially', () => {
    // Skipping approval is the one that costs money.
    expect(() => assertTransition('draft', 'accepted', ANYONE)).toThrow(/only/);
    expect(() => assertTransition('draft', 'converted', ANYONE)).toThrow();
    expect(() => assertTransition('pending_approval', 'accepted', ANYONE)).toThrow();
    expect(() => assertTransition('pending_approval', 'converted', ANYONE)).toThrow();
  });

  it('refuses to move a quote to the state it is already in', () => {
    for (const status of ALL) {
      expect(() => assertTransition(status, status, ANYONE), status).toThrow(/already/);
    }
  });

  it('refuses to move out of a terminal state', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ALL) {
        if (from === to) continue;
        expect(() => assertTransition(from, to, ANYONE), `${from}->${to}`).toThrow();
      }
    }
  });

  it('names what would have been allowed instead', () => {
    expect(() => assertTransition('draft', 'accepted', ANYONE)).toThrow(
      /pending_approval|sent|rejected/,
    );
  });
});

describe('who may move a quote', () => {
  it('lets only an approver approve', () => {
    expect(() => assertTransition('pending_approval', 'sent', APPROVER)).not.toThrow();
    expect(() => assertTransition('pending_approval', 'sent', OWNER)).toThrow(/requires sales/);
  });

  it('lets only the system expire a quote', () => {
    expect(() => assertTransition('sent', 'expired', SYSTEM)).not.toThrow();
    expect(() => assertTransition('sent', 'expired', OWNER)).toThrow(/requires system/);
    expect(() => assertTransition('sent', 'expired', APPROVER)).toThrow(/requires system/);
  });

  it('lets an owner act on their own quote, and staff act on any', () => {
    expect(() => assertTransition('sent', 'accepted', OWNER)).not.toThrow();
    expect(() => assertTransition('sent', 'accepted', APPROVER)).not.toThrow();
  });

  it('refuses a caller who is neither owner, approver nor system', () => {
    for (const t of TRANSITIONS) {
      expect(() => assertTransition(t.from, t.to, STRANGER), `${t.from}->${t.to}`).toThrow();
    }
  });
});

describe('the transition table itself', () => {
  it('carries an event name on every edge, so a move cannot be unaudited', () => {
    for (const t of TRANSITIONS) {
      expect(t.event, `${t.from}->${t.to}`).toMatch(/^quote\./);
    }
  });

  it('declares no duplicate edges', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only references declared statuses', () => {
    for (const t of TRANSITIONS) {
      expect(ALL, t.from).toContain(t.from);
      expect(ALL, t.to).toContain(t.to);
    }
  });

  it('leaves every terminal state with nowhere to go', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(allowedNextStates(status), status).toEqual([]);
      expect(isTerminal(status), status).toBe(true);
    }
  });

  it('makes every non-terminal state reachable and escapable', () => {
    for (const status of ALL) {
      if (isTerminal(status)) continue;
      expect(allowedNextStates(status).length, status).toBeGreaterThan(0);
    }
  });

  it('can reach a terminal state from anywhere', () => {
    for (const status of ALL) {
      if (isTerminal(status)) continue;
      const reachable = new Set<QuoteStatus>();
      const queue: QuoteStatus[] = [status];
      while (queue.length > 0) {
        const current = queue.shift() as QuoteStatus;
        for (const next of allowedNextStates(current)) {
          if (reachable.has(next)) continue;
          reachable.add(next);
          queue.push(next);
        }
      }
      expect([...reachable].some((s) => isTerminal(s)), status).toBe(true);
    }
  });
});

/** A bare env object; the real ProcessEnv type insists on NODE_ENV. */
function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

describe('approval threshold', () => {
  it('defaults to the configured value', () => {
    expect(approvalThresholdCents(env())).toBe(DEFAULT_APPROVAL_THRESHOLD_CENTS);
  });

  it('reads an override from the environment', () => {
    expect(approvalThresholdCents(env({ QUOTE_APPROVAL_THRESHOLD_CENTS: '100000' })))
      .toBe(100_000);
  });

  it('ignores a malformed override rather than trusting it', () => {
    for (const raw of ['abc', '-1', '1.5', '']) {
      expect(approvalThresholdCents(env({ QUOTE_APPROVAL_THRESHOLD_CENTS: raw })), raw)
        .toBe(DEFAULT_APPROVAL_THRESHOLD_CENTS);
    }
  });

  it('triggers at the threshold, not past it', () => {
    expect(requiresApproval(999_999, 1_000_000)).toBe(false);
    expect(requiresApproval(1_000_000, 1_000_000)).toBe(true);
    expect(requiresApproval(1_000_001, 1_000_000)).toBe(true);
  });
});

describe('what a submitted quote becomes', () => {
  it('sends a small human-drafted quote straight to draft', () => {
    expect(stateAfterSubmit(1_000, 'user')).toBe('draft');
  });

  it('holds a large human-drafted quote for approval', () => {
    expect(stateAfterSubmit(DEFAULT_APPROVAL_THRESHOLD_CENTS, 'user')).toBe('pending_approval');
  });

  it('always holds an agent-drafted quote for approval, however small', () => {
    expect(stateAfterSubmit(1, 'agent')).toBe('pending_approval');
    expect(stateAfterSubmit(0, 'agent')).toBe('pending_approval');
  });
});
