import { z } from 'zod';
import type { Role } from '@/lib/auth/roles';

/**
 * The agent's view of who it is acting for.
 *
 * Built on the server from the session, never from anything the model said.
 * Every tool re-derives its authorization from this, so a model that asks to
 * act as somebody else is asking the wrong party — the request never carries
 * an identity in the first place.
 */
export interface AgentPrincipal {
  userId: string;
  email: string;
  role: Role;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ToolOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string; code: ToolErrorCode };

export type ToolErrorCode =
  | 'invalid_input'
  | 'invalid_output'
  | 'not_allowed'
  | 'not_found'
  | 'forbidden_price'
  | 'illegal_transition'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'internal';

export interface ToolContext {
  principal: AgentPrincipal;
  /** Correlates every tool call and audit row from one agent run. */
  runId: string;
}

/**
 * A tool the agent may call.
 *
 * Both schemas are mandatory. Input validation is the obvious half; output
 * validation is the half that gets skipped and shouldn't be — a tool that
 * returns a shape the model does not expect produces a confidently wrong
 * answer rather than an error, and that failure is invisible in logs.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  /** Roles permitted to invoke it at all. Checked before the tool runs. */
  readonly allowedRoles: readonly Role[];
  /** JSON Schema handed to the model. Derived once, never per call. */
  readonly jsonSchema: Record<string, unknown>;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export const AGENT_MAX_TURNS = 8;
export const AGENT_TIMEOUT_MS = 60_000;
export const AGENT_MAX_SCHEMA_RETRIES = 2;
