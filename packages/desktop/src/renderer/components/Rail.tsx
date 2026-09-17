/** 左侧功能栏：页面导航（会话/插件/自动化/素材库/用量/设置） */
const ICONS: { key: string; title: string; path: string }[] = [
  {
    key: "chat",
    title: "会话",
    path: "M4 5h16v10H9l-5 4V5z",
  },
  {
    key: "plugins",
    title: "插件（MCP / Skills）",
    path: "M12 3l2.4 4.9L20 9l-4 3.9.9 5.6L12 15.8 7.1 18.5 8 12.9 4 9l5.6-1.1L12 3z",
  },
  {
    key: "automations",
    title: "定时任务",
    path: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 5h-2v6l5 3 1-1.7-4-2.3V7z",
  },
  {
    key: "media",
    title: "素材库",
    path: "M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zm1 12l3.5-4.5L12 15l2.5-3L19 16H6z",
  },
  {
    key: "usage",
    title: "用量统计",
    path: "M4 20V10h4v10H4zm6 0V4h4v16h-4zm6 0v-7h4v7h-4z",
  },
  {
    key: "settings",
    title: "设置",
    path: "M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l-2.1-.6a7 7 0 00-.7-1.7l1.1-1.9-1.6-1.6-1.9 1.1a7 7 0 00-1.7-.7L13.5 4h-3L10 6.1a7 7 0 00-1.7.7L6.4 5.7 4.8 7.3l1.1 1.9a7 7 0 00-.7 1.7L3 11.5v3l2.1.6a7 7 0 00.7 1.7l-1.1 1.9 1.6 1.6 1.9-1.1a7 7 0 001.7.7l.6 2.1h3l.6-2.1a7 7 0 001.7-.7l1.9 1.1 1.6-1.6-1.1-1.9a7 7 0 00.7-1.7l2.1-.6v-3z",
  },
];

export type View = "chat" | "plugins" | "automations" | "media" | "usage" | "settings";
export type Theme = "light" | "dark";

export function Rail({
  view,
  theme,
  onView,
  onToggleTheme,
}: {
  view: View;
  theme: Theme;
  onView: (v: View) => void;
  onToggleTheme: () => void;
}) {
  return (
    <nav className="rail">
      <div className="brand">w</div>
      {ICONS.map((ic) => (
        <button
          key={ic.key}
          className={view === ic.key ? "rail-btn active" : "rail-btn"}
          title={ic.title}
          onClick={() => onView(ic.key as View)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d={ic.path} />
          </svg>
        </button>
      ))}
      <button
        className="rail-btn rail-theme"
        title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? (
          /* 太阳：当前深色，点击切浅色 */
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0-5h.01L12 5h-.01L12 2zm0 17h.01L12 22h-.01L12 19zM2 12v-.01L5 12v.01L2 12zm17 0v-.01l3 .01v.01L19 12zM4.2 5.6l.7-.7 2.1 2.1-.7.7-2.1-2.1zm12.8 12.8l.7-.7 2.1 2.1-.7.7-2.1-2.1zM19.8 5.6l-2.1 2.1-.7-.7 2.1-2.1.7.7zM7 18.4l-2.1 2.1-.7-.7 2.1-2.1.7.7z" />
          </svg>
        ) : (
          /* 月亮：当前浅色，点击切深色 */
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M20.6 14.2A8.8 8.8 0 019.8 3.4a.7.7 0 00-.9-.9 9.8 9.8 0 105.3 19 9.6 9.6 0 006.4-6.4.7.7 0 00-.9-.9z" />
          </svg>
        )}
      </button>
    </nav>
  );
}
