export function MediaPage() {
  return (
    <div className="page">
      <h1>素材库</h1>
      <p className="page-sub">图片生成与素材画廊。</p>
      <div className="empty-hint">
        规划中：需要先在模型层新增图片生成 provider（ModelProvider 之外的媒体端口），
        当前 demo 未实现。CodePilot 的 Media Studio 对应能力将在此落地。
      </div>
    </div>
  );
}
