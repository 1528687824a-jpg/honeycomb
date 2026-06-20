import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Frown, HelpCircle, RefreshCw, Smile, Sparkles } from "lucide-react";
import { LogoFormationScene } from "./LogoFormationScene";
import "./styles.css";

type PreviewMood = "asking" | "sad" | "happy";

const storyboardFrames = [
  {
    time: "0.0s",
    title: "光点苏醒",
    body: "画面先保持安静，中心周围出现几束很细的暖光，给 logo 成形留出期待感。"
  },
  {
    time: "0.3s",
    title: "四周汇聚",
    body: "光轨从七个方向沿弧线向中心流动，避免机械直线平移，强化“汇聚”的感觉。"
  },
  {
    time: "0.9s",
    title: "描出蜂巢",
    body: "三枚蜂巢轮廓被光线描出来，用户能看见图形正在被生成，而不是突然贴图。"
  },
  {
    time: "1.4s",
    title: "核心亮起",
    body: "白色中心块从聚集的光里浮现，形成视觉焦点，也让 Honeycomb 标识更稳定。"
  },
  {
    time: "2.1s",
    title: "最终落位",
    body: "辅助光线退场，最终 PNG 标识清晰落位，留下轻微暖色光晕。"
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
          <p>独立窗口用于调试首次启动里的 logo 成形镜头，不进入正式操作面板。</p>
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
            <small>真实 GSAP 动画</small>
          </div>
          <div className="animationStageSurface">
            <div className="animationStageGlow" aria-hidden="true" />
            <div className="animationLogoFrame">
              <LogoFormationScene
                key={`${mood}-${runId}`}
                size={260}
                mood={mood}
                className="animationPreviewLogo"
                alt="Honeycomb logo"
              />
              <span className="animationPreviewTears" aria-hidden="true">
                <i />
                <i />
              </span>
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
