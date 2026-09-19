import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "../tools/tool";
import type { ToolSource } from "../tools/registry";
import type { JSONSchema } from "../types";
import type { McpServerSpec } from "../config/schema";
import { z } from "zod";

/**
 * 服务器声明沿用 config schema（settings.json 与插件 .mcp.json 共用同一模式）：
 * command → stdio；url → http（type:"sse" 显式指定 SSE）。
 */
export type McpServerConfig = McpServerSpec;

/** 合并调用方 headers 的 fetch（SSE EventSource 无法直接传 requestInit headers） */
function fetchWithHeaders(headers: Record<string, string>): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...headers },
    });
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
  const type = cfg.type ?? (cfg.command ? "stdio" : "http");
  if (type === "stdio") {
    if (!cfg.command) {
      throw new Error(
        `MCP 服务器 "${serverName}" 缺少 command。stdio 传输需配置 command（http/sse 则配置 url）`,
      );
    }
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      ...(cfg.env ? { env: { ...process.env, ...cfg.env } as Record<string, string> } : {}),
    });
    await client.connect(transport);
  } else {
    if (!cfg.url) {
      throw new Error(`MCP 服务器 "${serverName}" 缺少 url。${type} 传输需配置 url`);
    }
    const headers = cfg.headers ?? {};
    const transport =
      type === "sse"
        ? new SSEClientTransport(new URL(cfg.url), {
            eventSourceInit: { fetch: fetchWithHeaders(headers) },
            requestInit: { headers },
          })
        : new StreamableHTTPClientTransport(new URL(cfg.url), {
            requestInit: { headers },
          });
    await client.connect(transport);
  }
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
  // 命名空间键（如 plugin:文档:搜索）里的冒号等字符不合法于工具名，消毒为下划线
  const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const qualified = `mcp__${safeServer}__${info.name}`;
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
