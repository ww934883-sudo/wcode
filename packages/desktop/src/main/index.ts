import { app, BrowserWindow, dialog, ipcMain, screen } from "electron";
import path from "node:path";
import { errorMessage } from "@wcode/core";
import type { PermissionDecision, PermissionMode } from "@wcode/core";
import type { RuntimeInfo } from "../shared/protocol";
import { IpcHost } from "./host";
import { DesktopRuntime } from "./runtime";

// 主进程由 esbuild 打成 CJS（dist/main/index.cjs），__dirname 原生可用；
// 不能用 import.meta.url——esbuild 对 ESM 输入会降级成空对象
const here = __dirname;

let win: BrowserWindow | null = null;
let host: IpcHost | null = null;
let runtime: DesktopRuntime | null = null;

function pushInfo(): void {
  void runtime
    ?.info()
    .then((info: RuntimeInfo) => win?.webContents.send("wcode:info", info))
    .catch(() => {});
}

function registerIpc(): void {
  const rt = (): DesktopRuntime => {
    if (!runtime) throw new Error("运行时未就绪");
    return runtime;
  };

  ipcMain.handle("wcode:info", () => rt().info());
  ipcMain.handle("wcode:newSession", (_e, cwd: unknown) =>
    rt().createSession(typeof cwd === "string" && cwd ? cwd : undefined),
  );
  ipcMain.handle("wcode:openSession", (_e, cwd: unknown, sessionId: unknown) =>
    rt().openSession(String(cwd), String(sessionId)),
  );
  ipcMain.handle("wcode:forkSession", (_e, cwd: unknown, sessionId: unknown, userTurn: unknown) =>
    rt().forkSession(String(cwd), String(sessionId), Number(userTurn) || 0),
  );
  ipcMain.handle("wcode:rollbackSession", (_e, cwd: unknown, sessionId: unknown, userTurn: unknown) =>
    rt().rollbackSession(String(cwd), String(sessionId), Number(userTurn) || 0),
  );
  ipcMain.handle("wcode:deleteSession", (_e, cwd: unknown, sessionId: unknown) =>
    rt().deleteSession(String(cwd), String(sessionId)),
  );
  ipcMain.handle("wcode:setSessionPinned", (_e, sessionId: unknown, pinned: unknown) =>
    rt().setSessionPinned(String(sessionId), Boolean(pinned)),
  );
  ipcMain.handle("wcode:search", (_e, keyword: unknown) => rt().search(String(keyword ?? "")));
  ipcMain.handle("wcode:send", (_e, sessionId: unknown, text: unknown) =>
    rt().runTurn(String(sessionId), String(text ?? "")),
  );
  ipcMain.handle("wcode:abort", (_e, sessionId: unknown) => {
    rt().abort(String(sessionId));
  });
  ipcMain.handle("wcode:decide", (_e, _sessionId: unknown, askId: unknown, decision: unknown) => {
    if (decision === "allow" || decision === "deny" || decision === "allowAlways") {
      rt().decide(String(askId), decision satisfies PermissionDecision);
    }
  });
  ipcMain.handle("wcode:listModels", () => rt().listModels());
  ipcMain.handle("wcode:setModel", (_e, model: unknown) => {
    rt().setModel(String(model));
  });
  ipcMain.handle("wcode:setContextTokens", (_e, tokens: unknown) => {
    const n = Number(tokens);
    if (Number.isFinite(n) && n > 0) rt().setContextTokens(Math.round(n));
  });
  ipcMain.handle("wcode:setPermissionMode", (_e, mode: unknown) => {
    const m = String(mode);
    if (m === "plan" || m === "default" || m === "acceptEdits" || m === "bypass") {
      rt().setPermissionMode(m satisfies PermissionMode);
    }
  });
  ipcMain.handle("wcode:setThinkingLevel", (_e, level: unknown) => {
    const l = String(level);
    if (l === "off" || l === "low" || l === "medium" || l === "high") {
      rt().setThinkingLevel(l);
    }
  });
  ipcMain.handle("wcode:setPersona", (_e, name: unknown) => {
    rt().setPersona(typeof name === "string" && name !== "" ? name : null);
  });
  ipcMain.handle("wcode:pickFolder", async () => {
    if (!win) return null;
    const picked = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "选择项目文件夹",
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });
  ipcMain.handle("wcode:saveProviderKey", (_e, name: unknown, key: unknown) =>
    rt().saveProviderKey(String(name), String(key)),
  );
  ipcMain.handle("wcode:setActiveProvider", (_e, name: unknown) =>
    rt().setActiveProvider(String(name)),
  );
  ipcMain.handle("wcode:setMcpEnabled", (_e, name: unknown, enabled: unknown) =>
    rt().setMcpEnabled(String(name), Boolean(enabled)),
  );
  ipcMain.handle("wcode:addMcpServer", (_e, name: unknown, command: unknown, args: unknown, env: unknown) =>
    rt().addMcpServer(
      String(name),
      String(command),
      Array.isArray(args) ? args.map(String) : [],
      env && typeof env === "object" && !Array.isArray(env)
        ? (Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)])))
        : undefined,
    ),
  );
  ipcMain.handle("wcode:removeMcpServer", (_e, name: unknown) => rt().removeMcpServer(String(name)));
  ipcMain.handle("wcode:listAutomations", () => rt().listAutomations());
  ipcMain.handle("wcode:addAutomation", (_e, spec: unknown) => {
    const s = spec as Record<string, unknown>;
    const schedule = (s?.schedule ?? {}) as Record<string, unknown>;
    if (schedule.kind === "cron" && typeof schedule.expr === "string") {
      return rt().addAutomation({
        title: String(s.title ?? ""),
        prompt: String(s.prompt ?? ""),
        cwd: String(s.cwd ?? ""),
        mode: typeof s.mode === "string" ? s.mode : undefined,
        schedule: { kind: "cron", expr: schedule.expr },
        timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : undefined,
        maxRuns: typeof s.maxRuns === "number" ? s.maxRuns : undefined,
      });
    }
    if (schedule.kind === "once" && typeof schedule.runAt === "number") {
      return rt().addAutomation({
        title: String(s.title ?? ""),
        prompt: String(s.prompt ?? ""),
        cwd: String(s.cwd ?? ""),
        mode: typeof s.mode === "string" ? s.mode : undefined,
        schedule: { kind: "once", runAt: schedule.runAt },
        timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : undefined,
        maxRuns: typeof s.maxRuns === "number" ? s.maxRuns : undefined,
      });
    }
    throw new Error('调度规格无效：需要 { kind: "cron", expr } 或 { kind: "once", runAt }');
  });
  ipcMain.handle("wcode:removeAutomation", (_e, id: unknown) => rt().removeAutomation(String(id)));
  ipcMain.handle("wcode:setAutomationEnabled", (_e, id: unknown, enabled: unknown) =>
    rt().setAutomationEnabled(String(id), Boolean(enabled)),
  );
  ipcMain.handle("wcode:runAutomation", (_e, id: unknown) => rt().runAutomation(String(id)));
  ipcMain.handle("wcode:listAutomationRuns", (_e, id: unknown) =>
    rt().listAutomationRuns(String(id)),
  );
}

async function createWindow(): Promise<void> {
  // 理想尺寸不超过屏幕工作区（DIP 已含系统缩放）：否则在高缩放小屏上
  // 窗口比可视区还高，底部（含输入框）被裁在屏幕外
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(1280, area.width),
    height: Math.min(860, area.height),
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f7f6fa",
    autoHideMenuBar: true,
    title: "wcode 桌面版",
    // 窗口/任务栏图标（打包时 electron-builder 另用同源 .ico 生成 exe 图标）
    icon: path.join(here, "../../resources/icon.ico"),
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => {
    win = null;
  });
  await win.loadFile(path.join(here, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  host = new IpcHost(() => win);
  runtime = new DesktopRuntime(host, {
    userDataDir: app.getPath("userData"),
    demo: process.env.WCODE_DESKTOP_DEMO === "1",
    cb: { onInfo: pushInfo },
  });
  await runtime.init();
  registerIpc();
  await createWindow();
  pushInfo();
});

app.on("window-all-closed", () => {
  host?.dispose();
  runtime?.dispose();
  app.quit();
});

process.on("unhandledRejection", (err) => {
  console.error("[wcode] 未处理的 Promise 拒绝:", errorMessage(err));
});
