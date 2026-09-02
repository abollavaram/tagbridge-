import { NextResponse } from 'next/server';
import { currentViewer } from '@/lib/auth/guards';
import { agentRequestSchema, runAgent } from '@/lib/agent/loop';
import { llmAvailable } from '@/lib/agent/model';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Comfortably above the agent's own 60s deadline, so the in-app guardrail is
// the one that trips and the caller gets the deterministic fallback rather
// than a platform error page.
export const maxDuration = 90;

/**
 * The agent endpoint.
 *
 * The principal is built here, from the session, and is the only identity the
 * run ever has. Nothing in the request body names a user, a role or an owner,
 * so there is no field for a caller to lie in.
 *
 * The rate limit is keyed on the forwarded IP rather than the user id, because
 * the abuse case is one client hammering the endpoint, signed in or not.
 */
function clientKey(request: Request, userId: string | null): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim();
  return ip ? `ip:${ip}` : `user:${userId ?? 'anonymous'}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  const log = requestLogger(requestIdFrom(request.headers));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request', issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const viewer = await currentViewer();

  // A signed-out visitor gets the guest tool set: search and compatibility,
  // no quoting. The same rule the MCP server already applies, and the reason
  // the demo works for anyone who lands on the page — the interesting part of
  // this system is what it refuses to do, and you cannot see that from a
  // sign-in wall.
  const principal = viewer
    ? { userId: viewer.id, email: viewer.email, role: viewer.role }
    : {
        userId: '00000000-0000-4000-8000-000000000000',
        email: '',
        role: 'guest' as const,
      };

  const result = await runAgent({
    principal,
    request: parsed.data.request,
    rateKey: clientKey(request, viewer?.id ?? null),
  });

  if (result.stopped === 'rate_limited') {
    return NextResponse.json({ error: result.answer }, { status: 429 });
  }

  log.info(
    {
      runId: result.runId,
      model: result.model,
      turns: result.turns,
      tools: result.invocations.length,
      violations: result.violations.length,
      stopped: result.stopped,
      tookMs: result.tookMs,
    },
    'agent run',
  );

  return NextResponse.json({
    runId: result.runId,
    answer: result.answer,
    model: result.model,
    usedFallback: result.usedFallback,
    turns: result.turns,
    stopped: result.stopped,
    tookMs: result.tookMs,
    signedIn: Boolean(viewer),
    role: principal.role,
    // The trace is what makes a wrong answer debuggable rather than a shrug —
    // and on the assistant page it is the thing worth looking at.
    trace: result.invocations.map((i) => ({
      tool: i.name,
      ok: i.ok,
      code: i.code,
      guardrail: i.guardrail,
      error: i.error,
    })),
    guardrailsTripped: result.violations.map((v) => ({
      guardrail: v.guardrail,
      detail: v.detail,
    })),
  });
}

export function GET(): NextResponse {
  return NextResponse.json({
    endpoint: 'agent',
    model: llmAvailable() ? 'claude-opus-5' : 'deterministic-planner-v1',
    guardrails: [
      'no_model_price',
      'tool_allowlist',
      'tool_authority',
      'untrusted_content_isolation',
      'token_budget',
      'rate_limit',
      'circuit_breaker',
      'human_in_the_loop',
      'immutable_audit_log',
      'pii_redaction',
    ],
  });
}
