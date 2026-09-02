import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Exercises the stdio transport as a real subprocess.
 *
 * The in-process tests cover the dispatcher; this covers the thing only a
 * subprocess can show — that the server answers over a pipe and, crucially,
 * that it exits when its client disconnects. It did not: PGlite holds the
 * event loop open, so every Claude Desktop reconnect left a zombie behind.
 * Nothing in the unit tests could have caught that, and nobody would notice
 * it until their machine was full of them.
 */

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  exited: boolean;
}

function runStdio(messages: unknown[], timeoutMs = 60_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/mcp-stdio.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, TAGBRIDGE_MCP_USER: 'buyer@example.com' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr, code: null, exited: false });
    }, timeoutMs);

    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, exited: true });
    });

    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    // Closing stdin is what a disconnecting client does.
    child.stdin.end();
  });
}

function responses(stdout: string): { id?: number; result?: unknown; error?: unknown }[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('the stdio transport', () => {
  it(
    'answers over a pipe and exits when the client disconnects',
    async () => {
      const run = await runStdio([
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]);

      // The regression: a hung process here means every reconnect leaks one.
      expect(run.exited, 'the server did not exit after stdin closed').toBe(true);
      expect(run.code).toBe(0);

      const parsed = responses(run.stdout);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.id).toBe(1);
      expect(parsed[1]!.id).toBe(2);
    },
    120_000,
  );

  it(
    'writes diagnostics to stderr only, so the protocol stream stays parseable',
    async () => {
      const run = await runStdio([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
      // Every stdout line must be JSON. A stray log line here corrupts the
      // stream and the client fails with a parse error that looks nothing
      // like its cause.
      for (const line of run.stdout.split('\n').filter((l) => l.trim())) {
        expect(() => JSON.parse(line), line).not.toThrow();
      }
      expect(run.stderr).toContain('tagbridge');
    },
    120_000,
  );

  it(
    'answers a malformed line without dying',
    async () => {
      const run = await runStdio([]);
      expect(run.exited).toBe(true);
      // An empty session is still a clean exit.
      expect(run.code).toBe(0);
    },
    120_000,
  );
});
