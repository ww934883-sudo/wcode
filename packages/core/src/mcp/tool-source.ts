import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "../tools/tool";
import type { ToolSource } from "../tools/registry";
import type { JSONSchema } from "../types";
import { z } from "zod";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * MCP 接入（架构文档 §11）：每个 server 即一个 ToolSource（接缝二），
 * 工具名空间化为 mcp__<server>__<tool>，避免与内置工具冲突。
 * 入参校验交给 MCP server（本侧 z.any() 透传），schema 直接透传 JSON Schema。
 */
export async function createMcpToolSource(
  serverName: string,
  cfg: McpServerConfig,
): Promise<ToolSource> {
  const client = new Client({ name: "wcode", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    ...(cfg.env ? { env: { ...process.env, ...cfg.env } as Record<string, string> } : {}),
  });
  await client.connect(transport);
  return createMcpToolSourceFromClient(serverName, client);
}

/** 从已连接的 client 构造 ToolSource（测试用 InMemoryTransport 注入） */
export async function createMcpToolSourceFromClient(
  serverName: string,
  client: Client,
): Promise<ToolSource> {
  const list = await client.listTools();
  const tools: Tool[] = list.tools.map((t) =>
    mcpToolAdapter(serverName, client, {
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: "object" }) as JSONSchema,
    }),
  );
  return { id: `mcp:${serverName}`, listTools: async () => tools };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

function mcpToolAdapter(
  serverName: string,
  client: Client,
  info: McpToolInfo,
): Tool {
  const qualified = `mcp__${serverName}__${info.name}`;
  return {
    name: qualified,
    description: info.description ?? `MCP 工具 ${info.name}`,
    schema: z.any(), // 结构校验由 MCP server 负责
    jsonSchemaOverride: info.inputSchema,
    // 未知外部工具按写操作对待：默认 ask（架构文档 §11）
    isReadOnly: false,
    rulePatterns: () => [qualified],
    execute: async (input) => {
      const result = await client.callTool({
        name: info.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
      const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text =
        blocks.map((b) => (b.type === "text" && b.text ? b.text : `[${b.type}]`)).join("\n") ||
        "(空结果)";
      if (result.isError) {
        throw new Error(`MCP 工具报告错误: ${text}`);
      }
      return { content: text };
    },
  };
}
