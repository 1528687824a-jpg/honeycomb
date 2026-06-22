import { useId, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import honeycombLogoUrl from "./assets/honeycomb-logo.png";

gsap.registerPlugin(useGSAP);

type LogoFormationSceneProps = {
  size?: number;
  className?: string;
  alt?: string;
  mood?: "asking" | "sad" | "happy";
};

const SWIRL_STREAMS = [
  { id: "northEast", d: "M228 18 C178 18 158 48 132 74" },
  { id: "eastTop", d: "M256 74 C196 52 174 76 146 100" },
  { id: "east", d: "M260 132 C202 104 176 118 150 132" },
  { id: "southEast", d: "M226 222 C188 166 154 166 128 150" },
  { id: "south", d: "M132 258 C152 198 126 174 108 154" },
  { id: "southWest", d: "M32 232 C82 190 80 164 96 146" },
  { id: "west", d: "M-38 156 C34 174 54 134 78 124" },
  { id: "northWest", d: "M4 46 C70 46 82 78 96 94" }
] as const;

export function LogoFormationScene({
  size = 172,
  className = "",
  alt = "",
  mood = "asking"
}: LogoFormationSceneProps) {
  const sceneRef = useRef<HTMLSpanElement | null>(null);
  const rawId = useId().replace(/:/g, "");
  const streamGradientId = `formationStream-${rawId}`;
  const hotGradientId = `formationHot-${rawId}`;

  useGSAP(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const q = gsap.utils.selector(scene);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const streams = q<SVGPathElement>(".formationStream");
    const mainStreams = q<SVGPathElement>(".formationStream-main");
    const hotStreams = q<SVGPathElement>(".formationStream-hot");
    const ambient = q<HTMLSpanElement>(".formationAmbient");
    const ghostLogo = q<HTMLImageElement>(".formationGhostLogo");
    const logo = q<HTMLImageElement>(".formationLogoImage");

    gsap.set(ambient, { opacity: 0, scale: 0.7, transformOrigin: "50% 50%" });
    gsap.set(streams, { opacity: 0, strokeDashoffset: 1 });
    gsap.set(mainStreams, { strokeDasharray: 1, strokeDashoffset: 1 });
    gsap.set(hotStreams, { strokeDasharray: "0.18 0.82", strokeDashoffset: 1 });
    gsap.set(ghostLogo, {
      opacity: 0,
      scale: 1,
      filter: "blur(1.2px) brightness(1.05) saturate(1.25)",
      transformOrigin: "50% 50%"
    });
    gsap.set(logo, {
      opacity: 0,
      scale: 0.96,
      filter: "blur(8px) brightness(1.28)",
      transformOrigin: "50% 50%"
    });

    if (mood !== "asking") {
      gsap.set(ambient, { opacity: 0, scale: 1 });
      gsap.set(streams, { opacity: 0, strokeDashoffset: 1 });
      gsap.set(ghostLogo, { opacity: 0 });
      gsap.set(logo, {
        opacity: 1,
        scale: 1,
        filter: "drop-shadow(0 0 28px rgba(245, 185, 66, 0.52)) brightness(1)",
        transformOrigin: "50% 50%"
      });
      return;
    }

    if (reducedMotion) {
      gsap.set(ambient, { opacity: 0.44, scale: 1 });
      gsap.set(streams, { opacity: 0 });
      gsap.set(ghostLogo, { opacity: 0 });
      gsap.set(logo, {
        opacity: 1,
        scale: 1,
        filter: "drop-shadow(0 0 18px rgba(245, 185, 66, 0.34)) brightness(1)"
      });
      return;
    }

    const timeline = gsap.timeline({ defaults: { ease: "sine.out" } });

    timeline
      .to(ambient, { opacity: 0.24, scale: 0.84, duration: 0.55 }, 0)
      .to(mainStreams, { opacity: 0.96, duration: 0.18, stagger: 0.014 }, 0.04)
      .to(hotStreams, { opacity: 0.95, duration: 0.18, stagger: 0.015 }, 0.12)
      .to(mainStreams, {
        strokeDashoffset: 0,
        duration: 0.78,
        ease: "power2.inOut",
        stagger: { each: 0.018, from: "end" }
      }, 0.04)
      .to(hotStreams, {
        strokeDashoffset: -2.4,
        duration: 1.78,
        repeat: 1,
        ease: "none",
        stagger: { each: 0.018, from: "end" }
      }, 0.08)
      .to(ghostLogo, { opacity: 0.26, duration: 0.5 }, 0.22)
      .to(ambient, { opacity: 0.48, scale: 1, duration: 1.2 }, 0.58)
      .to(logo, {
        opacity: 1,
        scale: 1,
        filter: "drop-shadow(0 0 18px rgba(245, 185, 66, 0.34)) brightness(1)",
        duration: 1.25,
        ease: "sine.inOut"
      }, 0.68)
      .to(ghostLogo, { opacity: 0, duration: 0.65, ease: "sine.inOut" }, 1.42)
      .to(streams, { opacity: 0, duration: 0.62, stagger: 0.012, ease: "sine.inOut" }, 1.82)
      .to(ambient, {
        opacity: 0.58,
        scale: 1.04,
        duration: 1.8,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      }, 2.05);
  }, { scope: sceneRef, dependencies: [mood], revertOnUpdate: true });

  return (
    <span
      ref={sceneRef}
      className={`logoFormationScene logoFormationScene-${mood} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : "true"}
    >
      <span className="formationAmbient" aria-hidden="true" />
      <svg className="formationSvg" viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <linearGradient id={streamGradientId} x1="100%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#fff4b7" stopOpacity="0.22" />
            <stop offset="14%" stopColor="#fff4b7" stopOpacity="0.95" />
            <stop offset="58%" stopColor="#f5b942" />
            <stop offset="100%" stopColor="#f28a2e" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id={hotGradientId} x1="100%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#fff9d8" stopOpacity="0" />
            <stop offset="36%" stopColor="#fff9d8" />
            <stop offset="100%" stopColor="#f5b942" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="formationStreamLayer">
          {SWIRL_STREAMS.map((stream) => (
            <path
              key={`main-${stream.id}`}
              className={`formationStream formationStream-main formationStream--${stream.id}`}
              d={stream.d}
              pathLength={1}
              stroke={`url(#${streamGradientId})`}
            />
          ))}
          {SWIRL_STREAMS.map((stream) => (
            <path
              key={`hot-${stream.id}`}
              className={`formationStream formationStream-hot formationStream--${stream.id}`}
              d={stream.d}
              pathLength={1}
              stroke={`url(#${hotGradientId})`}
            />
          ))}
        </g>
      </svg>
      <img className="formationGhostLogo" src={honeycombLogoUrl} alt="" aria-hidden="true" draggable={false} />
      <img className="formationLogoImage" src={honeycombLogoUrl} alt={alt} draggable={false} />
    </span>
  );
}

export default LogoFormationScene;
