import { formatCents } from '@/lib/commerce/pricing';
import { isResolvable, translateCompatibility } from './translate';
import type { AgentModel, ModelMessage, ModelTurn } from './model';
import type { AgentTool, ToolCall } from './types';

/**
 * The deterministic planner.
 *
 * Implements the same `AgentModel` interface the real model does, so the loop,
 * the guardrails, and every test run against one code path. It is what runs
 * when no API key is configured and what the circuit breaker falls back to —
 * which means the fallback is not an untested branch that first executes
 * during an incident.
 *
 * It plans by reading the request, not by reasoning about it: translate the
 * words into structured input, decide which of the four shapes of task this
 * is, then walk a fixed sequence of tool calls. That ceiling is real and the
 * eval reports it honestly — it will not handle a request nobody anticipated.
 * What it will do is never invent a price, never call a tool it was not given,
 * and never claim something it did not look up.
 */

type Step =
  | { kind: 'resolve' }
  | { kind: 'search'; query: string }
  | { kind: 'price'; fromSearchHit: number }
  | { kind: 'quote' }
  | { kind: 'answer' };

interface ObservedResult {
  name: string;
  output: unknown;
  isError: boolean;
}

/** Pulls the first user request out of the transcript. */
function firstUserText(messages: readonly ModelMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text'
        ) {
          return String((block as { text?: string }).text ?? '');
        }
      }
    }
  }
  return '';
}

/** Every tool result already in the transcript, in order. */
function observedResults(messages: readonly ModelMessage[]): ObservedResult[] {
  const results: ObservedResult[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; tool_name?: string; content?: unknown; is_error?: boolean };
      if (b.type !== 'tool_result') continue;
      let parsed: unknown = b.content;
      if (typeof b.content === 'string') {
        try {
          parsed = JSON.parse(b.content);
        } catch {
          parsed = b.content;
        }
      }
      results.push({
        name: b.tool_name ?? '',
        output: parsed,
        isError: Boolean(b.is_error),
      });
    }
  }
  return results;
}

function wantsQuote(text: string): boolean {
  return /\bquote\b|\bquotation\b|\bprice it\b|\bwrite it up\b|\bproposal\b/i.test(text);
}

function wantsPrice(text: string): boolean {
  return /\bprice\b|\bcost\b|\bhow much\b|\bpricing\b|\bbudget\b/i.test(text);
}

function requestedQty(text: string): number {
  const match = /\b(\d+)\s*(?:x\b|units?\b|licen[cs]es?\b|copies\b|seats?\b)/i.exec(text);
  const qty = match ? Number(match[1]) : 1;
  return Number.isFinite(qty) && qty >= 1 && qty <= 9999 ? qty : 1;
}

interface Hit {
  variantId: string | null;
  sku: string;
  name: string;
}

function hitsFrom(result: ObservedResult | undefined): Hit[] {
  if (!result || result.isError) return [];
  const output = result.output as { hits?: unknown };
  if (!Array.isArray(output?.hits)) return [];
  return output.hits as Hit[];
}

export class DeterministicPlanner implements AgentModel {
  readonly name = 'deterministic-planner-v1';
  readonly deterministic = true;

  turn(input: {
    system: string;
    messages: ModelMessage[];
    tools: readonly AgentTool<never, never>[];
  }): Promise<ModelTurn> {
    const request = firstUserText(input.messages);
    const results = observedResults(input.messages);
    const available = new Set(input.tools.map((t) => t.name));
    const plan = this.plan(request, available);

    // One step per turn, indexed by how many tool results have come back.
    const step = plan[results.length] ?? { kind: 'answer' as const };
    const call = this.callFor(step, request, results, available);

    if (!call) {
      return Promise.resolve({
        text: this.summarise(request, results),
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    }

    return Promise.resolve({
      text: '',
      toolCalls: [call],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }

  /** The fixed sequence for this request. */
  private plan(request: string, available: ReadonlySet<string>): Step[] {
    const steps: Step[] = [];
    const translated = translateCompatibility(request);

    if (isResolvable(translated) && available.has('resolveCompatibility')) {
      steps.push({ kind: 'resolve' });
      // The resolver names SKUs; searching for the first one turns it into a
      // variant id, which is what a quote line actually needs.
      steps.push({ kind: 'search', query: '' });
    } else if (available.has('searchProducts')) {
      steps.push({ kind: 'search', query: request });
    }

    if ((wantsPrice(request) || wantsQuote(request)) && available.has('getPricing')) {
      steps.push({ kind: 'price', fromSearchHit: 0 });
    }
    if (wantsQuote(request) && available.has('createQuote')) {
      steps.push({ kind: 'quote' });
    }
    return steps;
  }

  private callFor(
    step: Step,
    request: string,
    results: readonly ObservedResult[],
    available: ReadonlySet<string>,
  ): ToolCall | null {
    const id = `det_${results.length}`;

    if (step.kind === 'resolve') {
      const translated = translateCompatibility(request);
      if (!isResolvable(translated)) return null;
      return {
        id,
        name: 'resolveCompatibility',
        input: {
          sourceDevice: translated.sourceDevice,
          destinationSystem: translated.destinationSystem,
          tagCount: translated.tagCount,
          ...(translated.transport ? { transport: translated.transport } : {}),
          redundancyRequired: translated.redundancyRequired,
          intermittentLink: translated.intermittentLink,
          legacyFirmware: translated.legacyFirmware,
        },
      };
    }

    if (step.kind === 'search') {
      let query = step.query;
      if (query === '') {
        // Search for the bundle's primary item rather than the raw request.
        const resolved = results.find((r) => r.name === 'resolveCompatibility' && !r.isError);
        const bundle = (resolved?.output as { bundle?: { sku?: string }[] } | undefined)?.bundle;
        query = bundle?.[0]?.sku ?? request;
      }
      if (!available.has('searchProducts')) return null;
      return { id, name: 'searchProducts', input: { query, limit: 5 } };
    }

    if (step.kind === 'price') {
      const search = results.find((r) => r.name === 'searchProducts');
      const hit = hitsFrom(search)[step.fromSearchHit];
      if (!hit?.variantId) return null;
      return { id, name: 'getPricing', input: { variantId: hit.variantId, qty: requestedQty(request) } };
    }

    if (step.kind === 'quote') {
      const search = results.find((r) => r.name === 'searchProducts');
      const hit = hitsFrom(search)[0];
      if (!hit?.variantId) return null;
      return {
        id,
        name: 'createQuote',
        input: {
          lines: [{ variantId: hit.variantId, qty: requestedQty(request) }],
          notes: 'Drafted from a compatibility walk-through.',
        },
      };
    }

    return null;
  }

  /**
   * The closing message.
   *
   * Built only from what the tools returned. Where a real model would
   * paraphrase, this quotes — which is duller and cannot hallucinate a price.
   */
  private summarise(request: string, results: readonly ObservedResult[]): string {
    const parts: string[] = [];

    const resolved = results.find((r) => r.name === 'resolveCompatibility' && !r.isError);
    if (resolved) {
      const output = resolved.output as {
        bundle?: { sku?: string; name?: string; why?: string }[];
        licenseTier?: string;
        gaps?: { severity?: string; detail?: string }[];
      };
      const bundle = output.bundle ?? [];
      if (bundle.length > 0) {
        parts.push(
          `That connection needs ${bundle.length} item${bundle.length === 1 ? '' : 's'}: ` +
            bundle.map((b) => `${b.name} (${b.sku})`).join(', ') +
            `. Licence tier: ${output.licenseTier}.`,
        );
      }
      const blocking = (output.gaps ?? []).filter((g) => g.severity === 'blocking');
      if (blocking.length > 0) {
        parts.push(`Blocking gaps: ${blocking.map((g) => g.detail).join('; ')}.`);
      }
    }

    const search = results.find((r) => r.name === 'searchProducts');
    const hits = hitsFrom(search);
    if (!resolved && hits.length > 0) {
      parts.push(
        `Closest matches: ${hits.slice(0, 3).map((h) => `${h.name} (${h.sku})`).join(', ')}.`,
      );
    }

    const priced = results.find((r) => r.name === 'getPricing' && !r.isError);
    if (priced) {
      const output = priced.output as { sku?: string; qty?: number; unitPriceCents?: number };
      if (typeof output.unitPriceCents === 'number') {
        parts.push(
          `Server-computed price for ${output.sku} at qty ${output.qty}: ` +
            `${formatCents(output.unitPriceCents)} each.`,
        );
      }
    }

    // Asked for a quote and had no tool to do it with: say so, rather than
    // answering a different question and letting the buyer wonder.
    const askedToQuote = wantsQuote(request);
    const couldQuote = results.some((r) => r.name === 'createQuote');
    if (askedToQuote && !couldQuote && (hits.length > 0 || resolved)) {
      parts.push('Sign in and I can draft that as a quote.');
    }

    const quoted = results.find((r) => r.name === 'createQuote' && !r.isError);
    if (quoted) {
      const output = quoted.output as {
        number?: string;
        status?: string;
        requiresApproval?: boolean;
      };
      parts.push(
        output.requiresApproval
          ? `Quote ${output.number} is drafted and waiting on human approval before it can be sent.`
          : `Quote ${output.number} is drafted (${output.status}).`,
      );
    }

    // Give what was found, then ask for what is still missing. A buyer who
    // named their PLC family and nothing else is better served by candidates
    // plus a question than by either one alone.
    const translated = translateCompatibility(request);
    if (!resolved && translated.missing.length > 0 && translated.missing.length < 3) {
      parts.push(
        `To size that properly, tell me the ${translated.missing
          .map((m) =>
            m === 'sourceDevice'
              ? 'source system'
              : m === 'destinationSystem'
                ? 'destination'
                : 'tag count',
          )
          .join(' and the ')}.`,
      );
    }

    const failures = results.filter((r) => r.isError);
    if (failures.length > 0 && parts.length === 0) {
      parts.push(
        `I could not complete that: ${failures
          .map((f) => String((f.output as { error?: string })?.error ?? 'a tool call failed'))
          .join('; ')}.`,
      );
    }

    if (parts.length === 0) {
      if (translated.missing.length > 0) {
        parts.push(
          `I need a little more to answer that — tell me the ${translated.missing
            .map((m) =>
              m === 'sourceDevice'
                ? 'source system'
                : m === 'destinationSystem'
                  ? 'destination'
                  : 'tag count',
            )
            .join(' and the ')}.`,
        );
      } else {
        parts.push('I could not find anything in the catalogue for that.');
      }
    }

    return parts.join(' ');
  }
}
