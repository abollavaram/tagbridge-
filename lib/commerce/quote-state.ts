import type { QuoteStatus } from '@/lib/db/schema';

/**
 * The quote state machine.
 *
 *   draft → pending_approval → sent → viewed → accepted → converted
 *                                   ↘ expired
 *                                   ↘ rejected
 *
 * Transitions are explicit and total: every legal edge is listed here, and
 * anything not listed throws. That matters because a quote is a commercial
 * commitment — a quote that slides from `draft` to `sent` without approval is
 * a discount nobody signed off, and a silent no-op is worse than an exception.
 */

export const QUOTE_STATUSES = [
  'draft',
  'pending_approval',
  'sent',
  'viewed',
  'accepted',
  'converted',
  'expired',
  'rejected',
] as const;

/** Who may cause a transition. The agent is deliberately the weakest. */
export type Actor = 'user' | 'agent' | 'system';

export interface Transition {
  from: QuoteStatus;
  to: QuoteStatus;
  /** Roles permitted to make this move, beyond the resource owner. */
  requires: 'owner' | 'sales' | 'system';
  event: string;
}

/**
 * Every legal edge. Read this as the specification, not as an optimisation:
 * anything absent here cannot happen.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'draft', to: 'pending_approval', requires: 'owner', event: 'quote.submitted' },
  // A quote can go straight out only when it needs no approval; the caller
  // decides that with the threshold rule below, not the state machine.
  { from: 'draft', to: 'sent', requires: 'sales', event: 'quote.sent' },
  { from: 'draft', to: 'rejected', requires: 'owner', event: 'quote.withdrawn' },
  { from: 'pending_approval', to: 'sent', requires: 'sales', event: 'quote.approved' },
  { from: 'pending_approval', to: 'rejected', requires: 'sales', event: 'quote.declined' },
  { from: 'pending_approval', to: 'draft', requires: 'sales', event: 'quote.returned' },
  { from: 'sent', to: 'viewed', requires: 'owner', event: 'quote.viewed' },
  { from: 'sent', to: 'accepted', requires: 'owner', event: 'quote.accepted' },
  { from: 'sent', to: 'rejected', requires: 'owner', event: 'quote.rejected' },
  { from: 'sent', to: 'expired', requires: 'system', event: 'quote.expired' },
  { from: 'viewed', to: 'accepted', requires: 'owner', event: 'quote.accepted' },
  { from: 'viewed', to: 'rejected', requires: 'owner', event: 'quote.rejected' },
  { from: 'viewed', to: 'expired', requires: 'system', event: 'quote.expired' },
  { from: 'accepted', to: 'converted', requires: 'sales', event: 'quote.converted' },
  { from: 'accepted', to: 'expired', requires: 'system', event: 'quote.expired' },
];

/** States from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly QuoteStatus[] = ['converted', 'expired', 'rejected'];

export class QuoteTransitionError extends Error {
  readonly from: QuoteStatus;
  readonly to: QuoteStatus;

  constructor(from: QuoteStatus, to: QuoteStatus, detail: string) {
    super(`cannot move a quote from ${from} to ${to}: ${detail}`);
    this.name = 'QuoteTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isTerminal(status: QuoteStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function findTransition(from: QuoteStatus, to: QuoteStatus): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function allowedNextStates(from: QuoteStatus): QuoteStatus[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

export interface TransitionContext {
  /** True when the caller owns the quote. */
  isOwner: boolean;
  /** True when the caller holds the sales or admin role. */
  isApprover: boolean;
  /** True when the caller is the scheduler or another trusted system path. */
  isSystem: boolean;
}

/**
 * Validates a proposed transition, throwing rather than returning false.
 *
 * Returns the transition so the caller has the event name to record: making
 * the event a property of the edge means a state change cannot be written
 * without its audit entry.
 */
export function assertTransition(
  from: QuoteStatus,
  to: QuoteStatus,
  context: TransitionContext,
): Transition {
  if (from === to) {
    throw new QuoteTransitionError(from, to, 'it is already in that state');
  }
  if (isTerminal(from)) {
    throw new QuoteTransitionError(from, to, `${from} is terminal`);
  }

  const transition = findTransition(from, to);
  if (!transition) {
    const allowed = allowedNextStates(from);
    throw new QuoteTransitionError(
      from,
      to,
      allowed.length > 0
        ? `only ${allowed.join(', ')} are reachable from ${from}`
        : `nothing is reachable from ${from}`,
    );
  }

  const permitted =
    transition.requires === 'system'
      ? context.isSystem
      : transition.requires === 'sales'
        ? context.isApprover
        : context.isOwner || context.isApprover;

  if (!permitted) {
    throw new QuoteTransitionError(
      from,
      to,
      `that move requires ${transition.requires}`,
    );
  }

  return transition;
}

/**
 * Whether a quote of this value must be approved before it can be sent.
 *
 * The threshold is a business rule, so it lives in code and is configurable by
 * environment rather than being a number an agent can talk its way past.
 */
export const DEFAULT_APPROVAL_THRESHOLD_CENTS = 2_500_000;

export function approvalThresholdCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QUOTE_APPROVAL_THRESHOLD_CENTS;
  if (!raw) return DEFAULT_APPROVAL_THRESHOLD_CENTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_APPROVAL_THRESHOLD_CENTS;
  return parsed;
}

export function requiresApproval(
  subtotalCents: number,
  threshold = approvalThresholdCents(),
): boolean {
  return subtotalCents >= threshold;
}

/**
 * The state a submitted quote should land in.
 *
 * An agent-drafted quote always goes to approval regardless of value: the
 * point of a human in the loop is that it is not the agent deciding whether
 * one is needed.
 */
export function stateAfterSubmit(subtotalCents: number, actor: Actor): QuoteStatus {
  if (actor === 'agent') return 'pending_approval';
  return requiresApproval(subtotalCents) ? 'pending_approval' : 'draft';
}
