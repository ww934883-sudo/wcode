#!/usr/bin/env node
/**
 * 零依赖 CDP（Chrome DevTools Protocol）客户端——配合远程调试端口启动的 Chrome/Edge 使用。
 * 需要 Node ≥ 22（内置 WebSocket 全局）。
 *
 * 用法（示例见 skills/control-browser/SKILL.md）：
 *   node cdp.js [--port 9222] tabs
 *   node cdp.js [--port 9222] open <url> [--tab <序号|targetId>] [--new]
 *   node cdp.js [--port 9222] eval "<js>" [--tab <序号|targetId>]
 *   node cdp.js [--port 9222] text [--tab <序号|targetId>]
 *   node cdp.js [--port 9222] shot <输出.png> [--tab <序号|targetId>]
 *   node cdp.js [--port 9222] close [--tab <序号|targetId>]   （不带 --tab 关闭整个浏览器）
 */
"use strict";

const args = process.argv.slice(2);
const opts = { port: 9222, tab: null, isNew: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--port") opts.port = Number(args[++i]);
  else if (a === "--tab") opts.tab = args[++i];
  else if (a === "--new") opts.isNew = true;
  else positional.push(a);
}
const cmd = positional.shift();
const arg = positional.join(" ");

const fail = (msg) => {
  console.error(`cdp: ${msg}`);
  process.exit(1);
};
if (!cmd) fail("缺少命令。可用: tabs | open <url> | eval <js> | text | shot <文件> | close");
const timeout = (ms, label) =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms),
  );

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${opts.port}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) fail(`调试端口返回 HTTP ${res.status}（${path}）`);
  return res.json();
}

/** 连接一个 CDP WebSocket，返回 send(method, params)（单连接串行发命令） */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send: (method, params = {}) =>
          new Promise((res2, rej2) => {
            const id = ++seq;
            const timer = setTimeout(
              () => {
                pending.delete(id);
                rej2(new Error(`CDP 命令 ${method} 超时`));
              },
              20_000,
            );
            pending.set(id, { res2, rej2, timer });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.rej2(new Error(`${msg.error.message ?? "CDP 错误"}`));
      else p.res2(msg.result);
    });
    ws.addEventListener("error", () => {
      reject(
        new Error(
          `无法连接 ${wsUrl}。请确认浏览器以 --remote-debugging-port=${opts.port} 启动（参见技能说明）`,
        ),
      );
    });
  });
}

async function pageTargets() {
  const list = await httpJson("/json");
  const pages = list.filter((t) => t.type === "page");
  if (pages.length === 0) fail("没有可用的页面标签页（type=page）");
  return pages;
}

async function pickTab() {
  const pages = await pageTargets();
  if (!opts.tab) return pages[0];
  const byIndex = Number(opts.tab);
  const hit = Number.isInteger(byIndex)
    ? pages[byIndex - 1]
    : pages.find((t) => t.id.startsWith(String(opts.tab)));
  if (!hit) {
    fail(
      `找不到标签页 "${opts.tab}"。可用（1 起）:\n` +
        pages.map((t, i) => `  ${i + 1}. ${t.id}  ${t.title}  ${t.url}`).join("\n"),
    );
  }
  return hit;
}

async function browserSocket() {
  const ver = await httpJson("/json/version");
  if (!ver.webSocketDebuggerUrl) fail("浏览器未开放 Browser 级 WebSocket（/json/version）");
  return connect(ver.webSocketDebuggerUrl);
}

async function main() {
  switch (cmd) {
    case "tabs": {
      const pages = await pageTargets();
      pages.forEach((t, i) =>
        console.log(`${i + 1}. ${t.id}  ${t.title || "(无标题)"}  ${t.url}`),
      );
      return;
    }
    case "open": {
      if (!arg) fail("用法: open <url>");
      if (opts.isNew) {
        const b = await browserSocket();
        const r = await b.send("Target.createTarget", { url: arg });
        console.log(`已新开标签页 ${r.targetId}`);
        b.close();
        return;
      }
      const tab = await pickTab();
      const c = await connect(tab.webSocketDebuggerUrl);
      await c.send("Page.navigate", { url: arg });
      console.log(`已在标签页 ${tab.id} 导航: ${arg}`);
      c.close();
      return;
    }
    case "eval": {
      if (!arg) fail("用法: eval <js 表达式>");
      const tab = await pickTab();
      const c = await connect(tab.webSocketDebuggerUrl);
      await c.send("Runtime.enable").catch(() => {});
      const r = await c.send("Runtime.evaluate", {
        expression: arg,
        returnByValue: true,
        awaitPromise: true,
      });
      c.close();
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        fail(`页面脚本异常: ${d.text}${d.exception?.description ? `\n${d.exception.description}` : ""}`);
      }
      console.log(JSON.stringify(r.result?.value ?? null, null, 2));
      return;
    }
    case "text": {
      const tab = await pickTab();
      const c = await connect(tab.webSocketDebuggerUrl);
      const r = await c.send("Runtime.evaluate", {
        expression: "document.body.innerText",
        returnByValue: true,
      });
      c.close();
      process.stdout.write(String(r.result?.value ?? ""));
      return;
    }
    case "shot": {
      const file = arg || "screenshot.png";
      const tab = await pickTab();
      const c = await connect(tab.webSocketDebuggerUrl);
      await c.send("Page.enable").catch(() => {});
      const r = await c.send("Page.captureScreenshot", { format: "png" });
      c.close();
      const { writeFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const buf = Buffer.from(r.data, "base64");
      writeFileSync(file, buf);
      console.log(`已保存: ${resolve(file)}（${buf.length} 字节，标签页 ${tab.id}）`);
      return;
    }
    case "close": {
      const b = await browserSocket();
      if (opts.tab) {
        const pages = await pageTargets();
        const byIndex = Number(opts.tab);
        const hit = Number.isInteger(byIndex)
          ? pages[byIndex - 1]
          : pages.find((t) => t.id.startsWith(String(opts.tab)));
        if (!hit) fail(`找不到标签页 "${opts.tab}"`);
        await b.send("Target.closeTarget", { targetId: hit.id });
        console.log(`已关闭标签页 ${hit.id}`);
      } else {
        await b.send("Browser.close", {});
        console.log("已关闭浏览器");
      }
      b.close();
      return;
    }
    default:
      fail(`未知命令 "${cmd}"。可用: tabs | open | eval | text | shot | close`);
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
