import { NextResponse } from 'next/server';
import { currentViewer } from '@/lib/auth/guards';
import { handleMessage, MCP_PROTOCOL_VERSION, SERVER_INFO } from '@/lib/mcp/server';
import { toolsFor } from '@/lib/agent/tools';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP over HTTP.
 *
 * One POST per JSON-RPC message, which is the simple half of the streamable
 * HTTP transport. No SSE stream is opened because nothing here is
 * server-initiated: every tool returns in milliseconds and the server has no
 * notifications to push. Advertising a stream we never write to would be a
 * capability that does not work.
 *
 * The principal comes from the session cookie. A signed-out client gets the
 * guest tool set — search and compatibility, no quoting — rather than a 401,
 * because catalogue discovery is exactly what an unauthenticated agent should
 * be able to do.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const log = requestLogger(requestIdFrom(request.headers));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      { status: 400 },
    );
  }

  const viewer = await currentViewer();
  const principal = viewer
    ? { userId: viewer.id, email: viewer.email, role: viewer.role }
    : // No session: a guest, with the read-only tool set and no user row.
      { userId: '00000000-0000-4000-8000-000000000000', email: '', role: 'guest' as const };

  const context = { principal, runId: crypto.randomUUID() };

  // A batch is an array; the spec allows it and clients do use it.
  if (Array.isArray(body)) {
    const responses = [];
    for (const message of body) {
      const response = await handleMessage(message, context);
      if (response) responses.push(response);
    }
    return responses.length === 0
      ? new NextResponse(null, { status: 202 })
      : NextResponse.json(responses);
  }

  const response = await handleMessage(body, context);
  if (!response) {
    // A notification. 202 with no body is what the transport expects.
    return new NextResponse(null, { status: 202 });
  }

  log.info(
    { method: (body as { method?: string })?.method, role: principal.role },
    'mcp message',
  );
  return NextResponse.json(response);
}

/** A human opening the URL should learn what this is and how to connect. */
export async function GET(): Promise<NextResponse> {
  const viewer = await currentViewer();
  const role = viewer?.role ?? 'guest';
  return NextResponse.json({
    server: SERVER_INFO,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'streamable-http (POST only; no server-initiated messages)',
    yourRole: role,
    toolsAvailableToYou: toolsFor(role).map((t) => t.name),
    note: 'POST a JSON-RPC 2.0 message here. Sign in for the quoting tools; a signed-out client gets catalogue search and compatibility.',
  });
}
