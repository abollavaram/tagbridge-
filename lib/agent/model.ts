import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '@/lib/env';
import type { AgentTool, ToolCall } from './types';

/**
 * The model seam.
 *
 * `AgentModel` is what the loop talks to. `AnthropicAgentModel` is the real
 * one. `DeterministicPlanner` is what runs when no key is configured, and is
 * also what the circuit breaker falls back to — so the fallback path is not a
 * special case that only executes during an incident, it is exercised by the
 * entire test suite and by every clean clone.
 *
 * The loop cannot tell them apart, which is the point: a guardrail that only
 * holds for one implementation is a guardrail that holds by accident.
 */

export interface ModelTurn {
  /** Text the model produced for the user. */
  text: string;
  /** Tools it wants run. Empty when it is finished. */
  toolCalls: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface AgentModel {
  readonly name: string;
  readonly deterministic: boolean;
  turn(input: {
    system: string;
    messages: ModelMessage[];
    tools: readonly AgentTool<never, never>[];
  }): Promise<ModelTurn>;
}

export class AnthropicAgentModel implements AgentModel {
  readonly name = 'claude-opus-5';
  readonly deterministic = false;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async turn(input: {
    system: string;
    messages: ModelMessage[];
    tools: readonly AgentTool<never, never>[];
  }): Promise<ModelTurn> {
    const response = await this.client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 8_000,
      // Adaptive thinking: the compatibility and quoting steps are exactly the
      // kind of multi-constraint reasoning it helps with, and the depth is
      // decided per request rather than by a fixed budget.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: input.system,
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.jsonSchema as Anthropic.Tool['input_schema'],
        // The schema is exact; a tool call that does not match it is a bug we
        // would rather see as a validation error than as a plausible guess.
        strict: true,
      })),
      messages: input.messages as Anthropic.MessageParam[],
    });

    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    const stopReason: ModelTurn['stopReason'] =
      response.stop_reason === 'tool_use'
        ? 'tool_use'
        : response.stop_reason === 'end_turn'
          ? 'end_turn'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : response.stop_reason === 'refusal'
              ? 'refusal'
              : 'other';

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

export function llmAvailable(): boolean {
  return Boolean(getEnv().ANTHROPIC_API_KEY);
}
