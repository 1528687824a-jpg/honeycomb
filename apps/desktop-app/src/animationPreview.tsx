import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Frown, HelpCircle, RefreshCw, Smile, Sparkles } from "lucide-react";
import { LogoFormationScene } from "./LogoFormationScene";
import "./styles.css";

type PreviewMood = "asking" | "sad" | "happy";

const storyboardFrames = [
  {
    time: "0.0s",
    title: "光线入场",
    body: "持续光带从外圈沿弧线向中心流动，统一右向左弯，形成漩涡感。"
  },
  {
    time: "0.3s",
    title: "同形虚影",
    body: "虚影直接复用最终 logo 图形，大小和形状一致，不再出现另一套蜂巢轮廓。"
  },
  {
    time: "0.9s",
    title: "logo 浮现",
    body: "最终 logo 慢慢从虚影里浮现，背景光团同步从暗到亮。"
  },
  {
    time: "1.4s",
    title: "光线退场",
    body: "流动光带逐步淡出，不抢最终标识的视觉重心。"
  },
  {
    time: "2.1s",
    title: "呼吸光团",
    body: "最终保留低亮度暖色光团，像呼吸一样轻微明暗变化。"
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
          <p>这里复用首次启动的真实舞台和动画组件，用来快速调试操作面板里会出现的效果。</p>
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
