import { z } from 'zod';
import { checkNoModelPrice, checkToolAuthority } from '@/lib/agent/guardrails';
import { ToolNotFound, toolsFor } from '@/lib/agent/tools';
import type { AgentPrincipal, AgentTool } from '@/lib/agent/types';
import { QuoteTransitionError } from '@/lib/commerce/quote-state';
import { CompatibilityError } from '@/lib/compatibility/resolver';

/**
 * The MCP server.
 *
 * Deliberately built on the same tool registry as the internal agent loop
 * rather than beside it. An MCP surface is a second consumer of the same
 * capabilities, and giving it its own definitions would mean two schemas, two
 * authorization checks and two places for the price rule to be forgotten.
 * Here `searchProducts` is one object; Claude Desktop and the in-process loop
 * both call it and both hit the same guardrails.
 *
 * That has a consequence worth stating: an MCP client is a *caller*, not an
 * authority. It arrives with a principal derived from its credential, and
 * `toolsFor(role)` decides what it can see. A client cannot enumerate a tool
 * its role does not have, let alone call one.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_INFO = {
  name: 'tagbridge',
  title: 'TagBridge industrial connectivity',
  version: '1.0.0',
} as const;

export const SERVER_INSTRUCTIONS = `TagBridge sells industrial connectivity software: OPC UA servers, protocol gateways, historian connectors and MQTT bridges.

Use searchProducts when someone describes a symptom or names a protocol, vendor or part number. Use resolveCompatibility when they name what they have and what they want it to reach — it returns a deterministic bundle, not a guess. Use getPricing for any number you intend to state.

You never set a price. Send variant ids and quantities; every amount comes back from the server. A quote you draft goes to a human for approval before it can be sent, and the tool will tell you so.`;

/* ------------------------------------------------------------ JSON-RPC 2.0 */

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  // A notification has no id; a request does. The difference decides whether
  // a response is sent at all.
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

/* ------------------------------------------------------------------ tools */

function describe(tool: AgentTool<never, never>) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema,
  };
}

/**
 * Runs one tool call.
 *
 * MCP distinguishes a protocol error (the call was malformed) from a tool
 * error (the call was fine and the tool refused). That distinction matters
 * here: a guardrail refusal is a *result* with `isError: true`, so the model
 * on the other end reads why and adapts, rather than a transport error it
 * would retry blindly.
 */
async function callTool(
  name: string,
  args: unknown,
  principal: AgentPrincipal,
  runId: string,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const available = toolsFor(principal.role);
  const tool = available.find((t) => t.name === name) as AgentTool<unknown, unknown> | undefined;

  if (!tool) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `No tool named ${JSON.stringify(name).slice(0, 80)} is available to this client.`,
        },
      ],
    };
  }

  const notAuthorised = checkToolAuthority(tool.name, tool.allowedRoles, principal);
  if (notAuthorised) {
    return { isError: true, content: [{ type: 'text', text: notAuthorised.detail }] };
  }

  const priced = checkNoModelPrice(args);
  if (priced) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Prices are computed by the server from the published volume breaks. Send variant ids and quantities only.',
        },
      ],
    };
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        },
      ],
    };
  }

  let output: unknown;
  try {
    output = await tool.execute(parsed.data, { principal, runId });
  } catch (error) {
    const message =
      error instanceof ToolNotFound ||
      error instanceof QuoteTransitionError ||
      error instanceof CompatibilityError
        ? error.message
        : 'the tool failed';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }

  const validated = tool.outputSchema.safeParse(output);
  if (!validated.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'the tool returned an unexpected shape' }],
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify(validated.data, null, 2) }] };
}

/* --------------------------------------------------------------- dispatch */

export interface McpContext {
  principal: AgentPrincipal;
  runId: string;
}

export async function handleRpc(
  request: JsonRpcRequest,
  context: McpContext,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  // A notification gets no response at all, per JSON-RPC. `initialized` is the
  // one every client sends, and answering it makes some clients hang.
  const isNotification = request.id === undefined;

  switch (request.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // Only what is implemented. A declared capability that does not work
        // is the same lie as a manifest pointing at a 404.
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: toolsFor(context.principal.role).map(describe) });

    case 'tools/call': {
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof params?.name !== 'string') {
        return err(id, RPC_ERRORS.invalidParams, 'params.name is required');
      }
      const result = await callTool(
        params.name,
        params.arguments ?? {},
        context.principal,
        context.runId,
      );
      return ok(id, result);
    }

    default:
      if (isNotification) return null;
      return err(id, RPC_ERRORS.methodNotFound, `unknown method ${request.method}`);
  }
}

/** Parses and dispatches one raw message. */
export async function handleMessage(
  raw: unknown,
  context: McpContext,
): Promise<JsonRpcResponse | null> {
  const parsed = jsonRpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return err(null, RPC_ERRORS.invalidRequest, 'not a valid JSON-RPC 2.0 request');
  }
  try {
    return await handleRpc(parsed.data, context);
  } catch (error) {
    return err(
      parsed.data.id ?? null,
      RPC_ERRORS.internal,
      error instanceof Error ? error.message : 'internal error',
    );
  }
}
