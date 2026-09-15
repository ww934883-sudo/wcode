import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpToolSourceFromClient } from "./tool-source";
import { ToolRegistry } from "../tools/registry";

async function makeFixtureClient() {
  const server = new Server(
    { name: "fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "回显输入",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: `echo:${JSON.stringify(req.params.arguments)}` }],
  }));
  const client = new Client({ name: "wcode-test", version: "0.0.1" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

describe("MCP ToolSource 契约", () => {
  it("listTools 适配：命名空间化 / schema 透传 / 默认按写操作", async () => {
    const source = await createMcpToolSourceFromClient("fixture", await makeFixtureClient());
    expect(source.id).toBe("mcp:fixture");
    const registry = new ToolRegistry();
    await registry.registerSource(source);

    const tool = registry.get("mcp__fixture__echo");
    expect(tool).toBeTruthy();
    expect(tool?.isReadOnly).toBe(false);

    const def = registry.toDefs().find((d) => d.name === "mcp__fixture__echo");
    expect(def?.description).toBe("回显输入");
    expect((def?.inputSchema as Record<string, unknown>).type).toBe("object");
  });

  it("execute 透传参数并回传文本结果", async () => {
    const source = await createMcpToolSourceFromClient("fixture", await makeFixtureClient());
    const tools = await source.listTools();
    const out = await tools[0]!.execute({ msg: "hi" }, null as never);
    expect(out.content).toBe('echo:{"msg":"hi"}');
  });

  it("同名冲突仍然受 registry 保护", async () => {
    const registry = new ToolRegistry();
    await registry.registerSource(
      await createMcpToolSourceFromClient("fixture", await makeFixtureClient()),
    );
    await expect(
      registry.registerSource(
        await createMcpToolSourceFromClient("fixture", await makeFixtureClient()),
      ),
    ).rejects.toThrow(/冲突/);
  });
});
