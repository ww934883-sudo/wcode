import type { ToolDef } from "../types";
import { toToolDef, type Tool } from "./tool";

/**
 * 工具来源（接缝二的核心）：内置工具是第一个 source；
 * M3 的 MCP、M4 的 Skills 都是「再来一个 source」，核心零改动。
 */
export interface ToolSource {
  id: string;
  listTools(): Promise<Tool[]> | Tool[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, { tool: Tool; sourceId: string }>();
  private readonly sources: ToolSource[] = [];

  async registerSource(source: ToolSource): Promise<void> {
    this.sources.push(source);
    for (const tool of await source.listTools()) {
      const existing = this.tools.get(tool.name);
      if (existing) {
        throw new Error(
          `工具名冲突: "${tool.name}" 来自 ${source.id}，已被 ${existing.sourceId} 注册`,
        );
      }
      this.tools.set(tool.name, { tool, sourceId: source.id });
    }
  }

  /** 已注册的 source 列表（/reload 迁移 MCP 等外部连接时用） */
  sourcesOf(): ToolSource[] {
    return [...this.sources];
  }

  list(): Tool[] {
    return [...this.tools.values()].map((e) => e.tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 导出为 provider 线格式工具定义 */
  toDefs(): ToolDef[] {
    return this.list().map(toToolDef);
  }
}

export function sourceOf(id: string, tools: Tool[]): ToolSource {
  return { id, listTools: () => tools };
}
