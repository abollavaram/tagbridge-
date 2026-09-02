'use client';

import { useRef, useState } from 'react';

/**
 * The assistant, and — more to the point — its trace.
 *
 * The agent has always worked; it was only reachable by API and by MCP, so on
 * the site itself the headline feature was invisible. What makes it worth
 * looking at is not the answer, which any chat box produces, but the record
 * underneath it: which tools ran, which were refused, and by which guardrail.
 *
 * So the trace is not a debug panel tucked behind a toggle. It is the point of
 * the page. A visitor asking for a discount can watch the refusal happen and
 * read the name of the rule that produced it.
 */

interface TraceEntry {
  tool: string;
  ok: boolean;
  code?: string;
  guardrail?: string;
  error?: string;
}

interface AgentResponse {
  runId: string;
  answer: string;
  model: string;
  usedFallback: boolean;
  turns: number;
  stopped: string;
  tookMs: number;
  signedIn: boolean;
  role: string;
  trace: TraceEntry[];
  guardrailsTripped: { guardrail: string; detail: string }[];
}

const TOOL_COPY: Record<string, string> = {
  searchProducts: 'Searched the catalogue',
  resolveCompatibility: 'Worked out what fits together',
  getPricing: 'Asked the server for a price',
  createQuote: 'Drafted a quote',
  updateQuoteStatus: 'Moved the quote',
  sendQuoteEmail: 'Tried to email the quote',
};

const GUARDRAIL_COPY: Record<string, string> = {
  no_model_price: 'The assistant tried to set a price',
  tool_allowlist: 'The assistant reached for a tool it does not have',
  tool_authority: 'That tool needs a higher role',
  token_budget: 'The run hit its token budget',
  tool_call_budget: 'The run hit its tool-call cap',
  turn_budget: 'The run hit its turn cap',
};

const EXAMPLES = [
  'We have ControlLogix PLCs on EtherNet/IP and need about 5,000 tags in SQL Server.',
  'Siemens S7-1500 into InfluxDB, 800 tags. What do I need?',
  'Find me an OPC UA server that talks to Siemens.',
  'Quote it at half price.',
];

function Chip({
  tone,
  children,
}: {
  tone: 'good' | 'stop' | 'warn' | 'neutral';
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    good: 'bg-good-100 text-good-600 dark:bg-good-600/15 dark:text-good-400',
    stop: 'bg-stop-100 text-stop-600 dark:bg-stop-600/15 dark:text-stop-400',
    warn: 'bg-warn-100 text-warn-600 dark:bg-warn-600/15 dark:text-warn-400',
    neutral: 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300',
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[0.68rem] font-medium uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Assistant({ signedIn }: { signedIn: boolean }) {
  const [request, setRequest] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AgentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || pending) return;

    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: trimmed }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'The assistant could not answer that.');
        return;
      }
      setResult(body as AgentResponse);
    } catch {
      setError('Could not reach the assistant. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(request);
        }}
        className="space-y-3"
      >
        <label htmlFor="assistant-request" className="sr-only">
          What are you trying to connect?
        </label>
        <div className="surface-card overflow-hidden focus-within:ring-2 focus-within:ring-signal-500">
          <textarea
            id="assistant-request"
            ref={inputRef}
            rows={3}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void ask(request);
              }
            }}
            placeholder="Describe what you have and where the data needs to go…"
            className="w-full resize-none bg-transparent px-4 py-3.5 text-base outline-none placeholder:text-ink-500"
          />
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2 hairline">
            <p className="text-xs text-ink-500">
              {signedIn
                ? 'Signed in — the assistant can draft a quote for you.'
                : 'Not signed in — search and compatibility only. Sign in to draft a quote.'}
            </p>
            <button
              type="submit"
              disabled={pending || request.trim().length === 0}
              className="rounded-md bg-signal-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-signal-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? 'Working…' : 'Ask'}
            </button>
          </div>
        </div>
      </form>

      {result === null && !pending ? (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-ink-500">
            Try one of these
          </p>
          <ul className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => {
                    setRequest(example);
                    inputRef.current?.focus();
                    void ask(example);
                  }}
                  className="surface-card px-3 py-1.5 text-left text-sm transition-colors hover:border-signal-300 hover:bg-signal-100/40 dark:hover:bg-signal-700/15"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
          <p className="pt-1 text-xs text-ink-500">
            The last one is there on purpose. Watch what the trace does with it.
          </p>
        </div>
      ) : null}

      {pending ? (
        <div className="surface-card p-5">
          <p className="tb-thinking font-mono text-sm text-ink-500">
            Running tools…
          </p>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-stop-600/30 bg-stop-100 px-4 py-3 text-sm text-stop-600 dark:bg-stop-600/10 dark:text-stop-400"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-5">
          <section aria-labelledby="answer" className="surface-card p-5">
            <h2 id="answer" className="sr-only">
              Answer
            </h2>
            <p className="text-[1.02rem] leading-relaxed">{result.answer}</p>
          </section>

          <section aria-labelledby="trace" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="trace" className="text-sm font-semibold uppercase tracking-widest text-ink-500">
                What it actually did
              </h2>
              <p className="font-mono text-xs text-ink-500">
                {result.turns} turn{result.turns === 1 ? '' : 's'} ·{' '}
                {Math.round(result.tookMs)} ms · {result.model}
              </p>
            </div>

            {result.trace.length === 0 ? (
              <p className="text-sm text-ink-500">
                It answered without needing a tool.
              </p>
            ) : (
              <ol className="space-y-2">
                {result.trace.map((entry, index) => {
                  const blocked = !entry.ok && Boolean(entry.guardrail);
                  return (
                    <li
                      key={`${entry.tool}-${index}`}
                      className="surface-card flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3"
                    >
                      <span className="font-mono text-xs text-ink-500">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="font-medium">
                        {TOOL_COPY[entry.tool] ?? entry.tool}
                      </span>
                      <span className="font-mono text-xs text-ink-500">{entry.tool}</span>
                      <span className="ml-auto flex items-center gap-2">
                        {entry.ok ? (
                          <Chip tone="good">ran</Chip>
                        ) : blocked ? (
                          <Chip tone="stop">blocked</Chip>
                        ) : (
                          <Chip tone="warn">{entry.code ?? 'refused'}</Chip>
                        )}
                      </span>
                      {!entry.ok && entry.error ? (
                        <p className="w-full text-sm text-ink-600 dark:text-ink-300">
                          {blocked && entry.guardrail
                            ? `${GUARDRAIL_COPY[entry.guardrail] ?? entry.guardrail}. `
                            : ''}
                          {entry.error}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}

            {result.guardrailsTripped.length > 0 ? (
              <div className="rounded-lg border border-stop-600/25 bg-stop-100/60 p-4 dark:bg-stop-600/10">
                <p className="text-sm font-semibold text-stop-600 dark:text-stop-400">
                  {result.guardrailsTripped.length} guardrail
                  {result.guardrailsTripped.length === 1 ? '' : 's'} held
                </p>
                <ul className="mt-2 space-y-1 text-sm text-ink-700 dark:text-ink-300">
                  {result.guardrailsTripped.map((tripped, index) => (
                    <li key={`${tripped.guardrail}-${index}`}>
                      <span className="font-mono text-xs">{tripped.guardrail}</span> —{' '}
                      {tripped.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-xs text-ink-500">
              Every price above came from the server. The assistant proposes a product and a
              quantity; it cannot state a price, and any quote it drafts waits for a human.
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
