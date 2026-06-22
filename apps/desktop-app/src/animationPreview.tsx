import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Frown, HelpCircle, RefreshCw, Smile, Sparkles } from "lucide-react";
import { LogoFormationScene } from "./LogoFormationScene";
import "./styles.css";

type PreviewMood = "asking" | "sad" | "happy";

const storyboardFrames = [
  {
    time: "0.0s",
    title: "播放素材",
    body: "询问态直接播放桌面 jimeng-2026-06-22-4479.mp4 接入后的效果。"
  },
  {
    time: "1.2s",
    title: "光线汇入",
    body: "使用你生成的视频里的弧线光流，不再使用手写 SVG 光线。"
  },
  {
    time: "3.9s",
    title: "最终定格",
    body: "视频停在最终 logo 画面；开心和难过状态仍走原来的反馈动画。"
  },
  {
    time: "4.0s",
    title: "保持一致",
    body: "预览窗口和首次启动共用同一个组件，所以看到的就是操作面板里的询问态。"
  }
];

const moods: Array<{ id: PreviewMood; label: string; icon: typeof HelpCircle }> = [
  { id: "asking", label: "询问", icon: HelpCircle },
  { id: "sad", label: "难过", icon: Frown },
  { id: "happy", label: "开心", icon: Smile }
];

function AnimationPreviewApp() {
  const [runId, setRunId] = useState(0);
  const [mood, setMood] = useState<PreviewMood>("asking");

  return (
    <main className={`animationPreviewShell animationPreviewShell-${mood}`}>
      <header className="animationPreviewHeader">
        <div>
          <p className="animationPreviewEyebrow">Honeycomb 动画分镜预览</p>
          <h1>Logo 成形动画</h1>
          <p>这里直接播放你提供的即梦动画素材，用来快速检查操作面板询问态里的真实效果。</p>
        </div>
        <button className="animationReplayButton" type="button" onClick={() => setRunId((value) => value + 1)}>
          <RefreshCw size={16} aria-hidden="true" />
          重播
        </button>
      </header>

      <section className="animationPreviewLayout">
        <aside className="animationStoryboardPanel" aria-label="动画分镜">
          <div className="animationPanelHeading">
            <Sparkles size={17} aria-hidden="true" />
            <span>分镜节点</span>
          </div>
          <ol className="animationStoryboardList">
            {storyboardFrames.map((frame) => (
              <li key={frame.time}>
                <strong>{frame.time}</strong>
                <div>
                  <h2>{frame.title}</h2>
                  <p>{frame.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>

        <section className="animationLivePanel" aria-label="实时动画预览">
          <div className="animationLiveTitle">
            <span>实时窗口</span>
            <small>与首次启动共用同一组件</small>
          </div>
          <div className={`animationStageSurface openclawInviteStage ${mood}`}>
            <div className="openclawLogoScene animationPreviewInviteScene">
              <div className="inviteConfetti" aria-hidden="true">
                {Array.from({ length: 30 }, (_, index) => <span key={index} />)}
              </div>
              <div className="inviteLogoWrap animationPreviewLogoWrap">
                <LogoFormationScene
                  key={`${mood}-${runId}`}
                  size={260}
                  mood={mood}
                  className="inviteLogo animationPreviewLogo"
                  alt="Honeycomb logo"
                />
                <span className="inviteTears" aria-hidden="true">
                  <i />
                  <i />
                </span>
              </div>
            </div>
          </div>
          <div className="animationMoodBar">
            <span>状态</span>
            <div className="animationMoodButtons">
              {moods.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={mood === item.id ? "active" : ""}
                    type="button"
                    onClick={() => {
                      setMood(item.id);
                      setRunId((value) => value + 1);
                    }}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

const root = document.getElementById("animation-preview-root");

if (root) {
  createRoot(root).render(<AnimationPreviewApp />);
}
