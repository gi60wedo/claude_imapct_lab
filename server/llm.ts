import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-sonnet-5-5';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema, `additionalProperties: false` with every property required (strict tool use). */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  system: string;
  user: string;
  tool: ToolSpec;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

/** The only thing brief.ts needs from an LLM; tests inject a fake. */
export interface LlmClient {
  callTool(call: ToolCall): Promise<unknown>;
}

/**
 * Sonnet 5.5 rejects forced `tool_choice` (400), so we use `auto`, `strict: true`
 * and an explicit instruction, then require a `tool_use` block in the reply.
 * The key is read from ANTHROPIC_API_KEY (or an `ant auth login` profile) on the server only.
 */
export function createAnthropicClient(opts: { fallbacks?: boolean } = {}): LlmClient {
  const client = new Anthropic();
  const useFallbacks = opts.fallbacks ?? process.env.BRIEF_FALLBACKS === 'on';
  return {
    async callTool({ system, user, tool, effort = 'low', maxTokens = 4000 }) {
      // Refusal fallbacks need the beta endpoint and add ~3 s per call, so they are opt-in (BRIEF_FALLBACKS=on).
      const params = {
        model: MODEL,
        max_tokens: maxTokens,
        output_config: { effort },
        system,
        tools: [{ name: tool.name, description: tool.description, strict: true, input_schema: tool.schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: `${user}\n\nRespond only by calling the ${tool.name} tool.` }],
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      };
      const response = useFallbacks
        ? await client.beta.messages.create(params as Anthropic.Beta.MessageCreateParamsNonStreaming)
        : await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
      if (response.stop_reason === 'refusal') throw new Error(`refusal: ${(response.stop_details as { category?: string } | null)?.category ?? 'unknown'}`);
      const block = response.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (!block || block.type !== 'tool_use') throw new Error(`no ${tool.name} tool call (stop_reason=${response.stop_reason})`);
      return block.input;
    },
  };
}
