/**
 * wcode 依赖门禁（架构文档 §1）：
 *  - core 只准依赖自身 + 纯库，禁止依赖 cli / provider-* / 任何模型 SDK
 *  - provider-* 只准依赖 @wcode/core，禁止互相依赖、禁止依赖 cli
 *  - cli 是组合根，可依赖所有包；TUI 代码限定在 cli/src/ui 内
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-not-depend-on-ui-or-providers",
      severity: "error",
      comment: "core 引擎不得依赖 cli 或任何 provider 包（M1-生产级架构设计 §1）",
      from: { path: "packages/core/" },
      to: { path: "packages/(cli|provider-[^/]+)/" },
    },
    {
      name: "core-no-model-sdk",
      severity: "error",
      comment: "core 禁止直接依赖模型 SDK，模型访问必须经 ModelProvider 端口",
      from: { path: "packages/core/" },
      to: { dependencyTypes: ["npm"], path: "^(node_modules/)?(@anthropic-ai/|openai|ink)" },
    },
    {
      name: "provider-anthropic-isolated",
      severity: "error",
      comment:
        "provider 只准依赖 core 与自身（包内相对导入合法），禁止依赖 cli 或其他 provider",
      from: { path: "^packages/provider-anthropic/" },
      to: { path: "^packages/(cli|provider-)/", pathNot: "^packages/provider-anthropic/" },
    },
    {
      name: "cli-ui-contained",
      severity: "error",
      comment:
        "TUI 代码必须收在 cli/src/ui 内；唯一例外是组合根 bin.ts（装配 AgentHost）",
      from: { path: "^packages/cli/src/", pathNot: "^packages/cli/src/bin\\.ts$" },
      to: { path: "^packages/cli/src/ui/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      extensions: [".ts", ".js", ".mjs", ".cjs"],
    },
  },
};
