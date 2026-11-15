import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One assistant turn: either tool calls, or a final answer. */
export interface AgentModel {
  readonly name: string;
  turn(args: { system: string; history: Anthropic.MessageParam[]; tools: Anthropic.Tool[] }): Promise<{ text: string; toolCalls: ToolCall[]; content: Anthropic.ContentBlockParam[] }>;
}

export class ClaudeAgent implements AgentModel {
  private client = new Anthropic();
  constructor(readonly name = process.env.AGENT_MODEL ?? "claude-sonnet-5-5") {}

  async turn({ system, history, tools }: Parameters<AgentModel["turn"]>[0]) {
    const res = await this.client.messages.create({ model: this.name, max_tokens: 1024, system, tools, messages: history });
    const toolCalls = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { text, toolCalls, content: res.content as Anthropic.ContentBlockParam[] };
  }
}

export interface Transcript {
  finalText: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; isError: boolean }>;
  turns: number;
}

/**
 * The agent loop: the model sees the MCP server's own tool list (names,
 * descriptions, JSON Schemas) and every call goes through the MCP client,
 * so the eval exercises the same path a real MCP host would.
 */
export async function runAgent(model: AgentModel, mcp: Client, system: string, task: string, maxTurns = 10): Promise<Transcript> {
  const tools: Anthropic.Tool[] = (await mcp.listTools()).tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  const history: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const calls: Transcript["toolCalls"] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const { text, toolCalls, content } = await model.turn({ system, history, tools });
    history.push({ role: "assistant", content });
    if (toolCalls.length === 0) return { finalText: text, toolCalls: calls, turns: turn };

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolCalls) {
      const res = (await mcp.callTool({ name: call.name, arguments: call.input })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      const output = res.content.map((c) => c.text ?? "").join("");
      calls.push({ name: call.name, input: call.input, isError: Boolean(res.isError) });
      results.push({ type: "tool_result", tool_use_id: call.id, content: output, ...(res.isError ? { is_error: true } : {}) });
    }
    history.push({ role: "user", content: results });
  }
  return { finalText: "(ran out of turns)", toolCalls: calls, turns: maxTurns };
}

/** Last tool result text in the history, for scripted plans that depend on earlier results. */
export function lastToolOutput(history: Anthropic.MessageParam[]): string {
  const last = history.at(-1);
  if (!last || typeof last.content === "string") return "";
  for (const b of last.content) {
    if (b.type === "tool_result") return typeof b.content === "string" ? b.content : "";
  }
  return "";
}
