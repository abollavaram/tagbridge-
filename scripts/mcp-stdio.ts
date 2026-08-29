/**
 * MCP over stdio, for Claude Desktop and any other local client.
 *
 * Reads newline-delimited JSON-RPC on stdin and writes responses on stdout.
 * Nothing else may be written to stdout — a stray console.log corrupts the
 * stream and the client fails with a parse error that looks nothing like its
 * cause — so every diagnostic goes to stderr.
 *
 * The principal is resolved from the seeded user named by TAGBRIDGE_MCP_USER,
 * defaulting to the buyer. A stdio server has no session to read, and
 * inventing an admin identity because the process happens to be local is
 * exactly the shortcut that makes an MCP server dangerous.
 *
 *   claude_desktop_config.json:
 *   { "mcpServers": { "tagbridge": {
 *       "command": "pnpm", "args": ["--silent", "mcp"], "cwd": "/path/to/tagbridge" } } }
 */
import { createInterface } from 'node:readline';
import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { firstRow } from '@/lib/db/rows';
import { handleMessage, SERVER_INFO } from '@/lib/mcp/server';
import type { Role } from '@/lib/auth/roles';

async function resolvePrincipal() {
  const email = process.env.TAGBRIDGE_MCP_USER ?? 'buyer@example.com';
  const db = await getDatabase();
  const row = firstRow<{ id: string; email: string; role: Role }>(
    await db.execute(
      sql`select id, email, role::text as role from users where email = ${email} limit 1`,
    ),
  );
  if (!row) {
    throw new Error(
      `no seeded user ${email}. Run \`pnpm db:setup\`, or set TAGBRIDGE_MCP_USER to a seeded address.`,
    );
  }
  return { userId: row.id, email: row.email, role: row.role };
}

async function main(): Promise<void> {
  const principal = await resolvePrincipal();
  process.stderr.write(
    `${SERVER_INFO.name} ${SERVER_INFO.version} on stdio, acting as ${principal.email} (${principal.role})\n`,
  );

  const rl = createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        })}\n`,
      );
      continue;
    }

    const response = await handleMessage(message, {
      principal,
      runId: crypto.randomUUID(),
    });
    // A notification produces nothing. Writing an empty line for one would
    // still be a message the client has to parse.
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
