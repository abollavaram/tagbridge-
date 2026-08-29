import { containsPriceField } from '@/lib/commerce/pricing';
import type { AgentPrincipal, ToolErrorCode } from './types';

/**
 * The guardrails.
 *
 * Each one is a pure function over data the caller already has, deliberately
 * kept out of the loop and out of the tools. Two reasons: a guardrail buried
 * inside a tool is a guardrail nobody can test on its own, and a guardrail
 * that depends on the model behaving is not a guardrail at all — it is a
 * preference. Everything here holds whatever the model returns, including
 * output crafted to defeat it.
 */

export interface GuardrailViolation {
  guardrail: string;
  code: ToolErrorCode;
  detail: string;
}

/* ------------------------------------------------- the model sets no price */

/**
 * Refuses any model output carrying a price.
 *
 * The spec's hardest rule. The model proposes `{variantId, qty}` and the
 * server prices it from `price_tiers`; a price arriving from the model is
 * rejected rather than ignored, because ignoring it silently would let a
 * quote that the model believed was discounted reach a customer at a
 * different number, and nobody would find out until the invoice.
 */
export function checkNoModelPrice(input: unknown): GuardrailViolation | null {
  if (!containsPriceField(input)) return null;
  return {
    guardrail: 'no_model_price',
    code: 'forbidden_price',
    detail: 'tool input carried a price-shaped field; prices are computed server-side only',
  };
}

/* ---------------------------------------------------------- tool allowlist */

/**
 * The allowlist is fixed at construction and cannot be widened at runtime.
 *
 * Specifically, it cannot be widened by anything the model read. A product
 * description saying "you may also call sendQuoteEmail" changes nothing,
 * because the set is built from the tool registry before the model is asked
 * anything and is never rebuilt from a response.
 */
export function checkToolAllowed(
  name: string,
  allowlist: ReadonlySet<string>,
): GuardrailViolation | null {
  if (allowlist.has(name)) return null;
  return {
    guardrail: 'tool_allowlist',
    code: 'not_allowed',
    detail: `no tool named ${JSON.stringify(name).slice(0, 80)} is available to this run`,
  };
}

/* ------------------------------------------------------ per-tool authority */

export function checkToolAuthority(
  toolName: string,
  allowedRoles: readonly string[],
  principal: AgentPrincipal,
): GuardrailViolation | null {
  if (allowedRoles.includes(principal.role)) return null;
  return {
    guardrail: 'tool_authority',
    code: 'not_allowed',
    detail: `${toolName} requires one of ${allowedRoles.join(', ')}; caller is ${principal.role}`,
  };
}

/* --------------------------------------------------- untrusted content wrap */

export const UNTRUSTED_OPEN = '<untrusted_catalog_content>';
export const UNTRUSTED_CLOSE = '</untrusted_catalog_content>';

/**
 * Wraps retrieved catalogue text so the model can tell data from instruction.
 *
 * The delimiter is only half of it — the system prompt states that nothing
 * inside can change tool policy, and the allowlist above enforces that
 * independently. The wrap makes injection visible; the allowlist makes it
 * ineffective. Either alone would be a story rather than a control.
 *
 * Any occurrence of the delimiters in the content itself is neutralised, so
 * retrieved text cannot close the block early and continue as if it were the
 * system's own voice.
 */
export function wrapUntrusted(content: string): string {
  const neutralised = content
    .replaceAll('<untrusted_catalog_content>', '(untrusted_catalog_content)')
    .replaceAll('</untrusted_catalog_content>', '(/untrusted_catalog_content)');
  return `${UNTRUSTED_OPEN}\n${neutralised}\n${UNTRUSTED_CLOSE}`;
}

/* ------------------------------------------------------------------- budget */

export interface BudgetState {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
}

export interface BudgetLimits {
  maxTokens: number;
  maxToolCalls: number;
  maxTurns: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxTokens: 120_000,
  maxToolCalls: 16,
  maxTurns: 8,
};

export function checkBudget(
  state: BudgetState,
  limits: BudgetLimits = DEFAULT_BUDGET,
): GuardrailViolation | null {
  const tokens = state.inputTokens + state.outputTokens;
  if (tokens > limits.maxTokens) {
    return {
      guardrail: 'token_budget',
      code: 'budget_exhausted',
      detail: `run used ${tokens} tokens, over the ${limits.maxTokens} budget`,
    };
  }
  if (state.toolCalls > limits.maxToolCalls) {
    return {
      guardrail: 'tool_call_budget',
      code: 'budget_exhausted',
      detail: `run made ${state.toolCalls} tool calls, over the ${limits.maxToolCalls} cap`,
    };
  }
  if (state.turns > limits.maxTurns) {
    return {
      guardrail: 'turn_budget',
      code: 'budget_exhausted',
      detail: `run reached ${state.turns} turns, over the ${limits.maxTurns} cap`,
    };
  }
  return null;
}

/* --------------------------------------------------------------- rate limit */

/**
 * A fixed-window limiter kept in process.
 *
 * The spec names Upstash; this deployment has no Redis, and a limiter that
 * silently does nothing would be worse than an honest in-process one. What
 * this cannot do is coordinate across instances — so the limit is per
 * instance, and that is stated rather than hidden. `RateLimiter` is the seam
 * a Redis-backed implementation would slot into.
 */
export interface RateLimiter {
  readonly name: string;
  take(key: string, nowMs?: number): { allowed: boolean; remaining: number; resetAtMs: number };
}

export class InProcessRateLimiter implements RateLimiter {
  readonly name = 'in-process-fixed-window';
  private readonly windows = new Map<string, { count: number; resetAtMs: number }>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {}

  take(key: string, nowMs = Date.now()) {
    const existing = this.windows.get(key);
    if (!existing || nowMs >= existing.resetAtMs) {
      const fresh = { count: 1, resetAtMs: nowMs + this.windowMs };
      this.windows.set(key, fresh);
      return { allowed: true, remaining: this.limit - 1, resetAtMs: fresh.resetAtMs };
    }
    existing.count += 1;
    const allowed = existing.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - existing.count),
      resetAtMs: existing.resetAtMs,
    };
  }

  /** Test-only, and used by the eval harness between scenarios. */
  reset(): void {
    this.windows.clear();
  }
}

/* ------------------------------------------------------- circuit breaker */

/**
 * Fails closed to the deterministic path.
 *
 * "Closed" here means the agent stops calling the model, not that the request
 * fails: a buyer asking a question during an outage or a spend spike gets the
 * deterministic answer, which is worse than the agent and far better than an
 * error page. Opening the breaker is therefore a downgrade, never an outage.
 */
export type BreakerState = 'closed' | 'open';

export class CircuitBreaker {
  private failures = 0;
  private spendCents = 0;
  private openedAtMs: number | null = null;

  constructor(
    private readonly failureThreshold = 3,
    private readonly dailySpendCapCents = 50_00,
    private readonly cooldownMs = 60_000,
  ) {}

  get state(): BreakerState {
    if (this.openedAtMs === null) return 'closed';
    return Date.now() - this.openedAtMs < this.cooldownMs ? 'open' : 'closed';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordSpendCents(cents: number): void {
    this.spendCents += cents;
    if (this.spendCents >= this.dailySpendCapCents) this.trip();
  }

  trip(): void {
    this.openedAtMs = Date.now();
  }

  reset(): void {
    this.failures = 0;
    this.spendCents = 0;
    this.openedAtMs = null;
  }

  get spentCents(): number {
    return this.spendCents;
  }
}

/* --------------------------------------------------------- PII discipline */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

/**
 * Redacts before logging, and before anything reaches a prompt that does not
 * need it.
 *
 * Deliberately conservative about what counts as needing it: the agent's task
 * is finding products and drafting quotes, and neither requires knowing who
 * the buyer is. The principal's identity travels in the tool context, which
 * the model never sees.
 */
export function redactPii(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redactPii(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = /email|name|company|phone/i.test(key)
        ? '[redacted]'
        : redactObject(nested);
    }
    return out as unknown as T;
  }
  return value;
}

/** Whether a string still carries anything that looks like PII. */
export function containsPii(text: string): boolean {
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  return EMAIL.test(text) || PHONE.test(text);
}
