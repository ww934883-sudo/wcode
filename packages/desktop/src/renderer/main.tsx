import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 首帧前设主题：localStorage 优先，缺省跟随系统（与 App 内 state 初始化同一逻辑）
{
  const saved = localStorage.getItem("wcode-theme");
  const dark = saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

createRoot(document.getElementById("root")!).render(<App />);
