import { useId, useRef } from "react";
import gsap from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { useGSAP } from "@gsap/react";
import honeycombLogoUrl from "./assets/honeycomb-logo.png";

gsap.registerPlugin(MotionPathPlugin, useGSAP);

type LogoFormationSceneProps = {
  size?: number;
  className?: string;
  alt?: string;
  mood?: "asking" | "sad" | "happy";
};

const FORMATION_BEAMS = [
  { id: "north", d: "M110 -26 C111 18 104 46 96 75", count: 4 },
  { id: "upperLeft", d: "M-26 28 C26 16 55 34 83 78", count: 5 },
  { id: "upperRight", d: "M246 28 C194 16 165 34 137 78", count: 5 },
  { id: "left", d: "M-28 150 C24 132 49 125 76 122", count: 5 },
  { id: "right", d: "M248 150 C196 132 171 125 144 122", count: 5 },
  { id: "lowerLeft", d: "M24 244 C42 194 73 163 98 145", count: 4 },
  { id: "lowerRight", d: "M196 244 C178 194 147 163 122 145", count: 4 }
] as const;

const FORMATION_CELLS = [
  { id: "top", d: "M110 13 L160 42 L160 98 L110 127 L60 98 L60 42 Z" },
  { id: "left", d: "M54 81 L104 110 L104 166 L54 195 L4 166 L4 110 Z" },
  { id: "right", d: "M166 81 L216 110 L216 166 L166 195 L116 166 L116 110 Z" }
] as const;

const CORE_PATH = "M110 72 L140 89 L140 123 L110 140 L80 123 L80 89 Z";

export function LogoFormationScene({
  size = 172,
  className = "",
  alt = "",
  mood = "asking"
}: LogoFormationSceneProps) {
  const sceneRef = useRef<HTMLSpanElement | null>(null);
  const rawId = useId().replace(/:/g, "");
  const beamGradientId = `formationBeam-${rawId}`;
  const cellGradientId = `formationCell-${rawId}`;
  const coreGradientId = `formationCore-${rawId}`;
  const glowId = `formationGlow-${rawId}`;

  useGSAP(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cells = gsap.utils.toArray<SVGPathElement>(".formationCell");
    const streams = gsap.utils.toArray<SVGPathElement>(".formationStream");
    const particles = gsap.utils.toArray<SVGCircleElement>(".formationParticle");

    gsap.set(cells, { strokeDasharray: 1, strokeDashoffset: 1, opacity: 0 });
    gsap.set(streams, { strokeDasharray: "0.1 0.9", strokeDashoffset: 1, opacity: 0 });
    gsap.set(particles, { opacity: 0, scale: 0.35, transformOrigin: "50% 50%" });
    gsap.set(".formationCore", { opacity: 0, scale: 0.58, transformOrigin: "50% 50%" });
    gsap.set(".formationPulse", { opacity: 0, scale: 0.14, transformOrigin: "50% 50%" });
    gsap.set(".formationLogoImage", {
      opacity: 0,
      scale: 0.9,
      filter: "blur(8px) brightness(1.65)",
      transformOrigin: "50% 50%"
    });

    if (reducedMotion) {
      gsap.set(cells, { strokeDashoffset: 0, opacity: 0.7 });
      gsap.set(".formationCore", { opacity: 0.8, scale: 1 });
      gsap.set(".formationLogoImage", { opacity: 1, scale: 1, filter: "blur(0px) brightness(1)" });
      return;
    }

    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });

    timeline
      .to(streams, { opacity: 0.9, duration: 0.12, stagger: 0.02 }, 0.12)
      .to(streams, { strokeDashoffset: 0, duration: 0.86, stagger: 0.025, ease: "power2.in" }, 0.16)
      .to(".formationPulse", { opacity: 0.95, scale: 1, duration: 0.55, ease: "power2.out" }, 0.45)
      .to(".formationPulse", { opacity: 0, scale: 1.55, duration: 0.62, ease: "power2.in" }, 0.92)
      .to(cells, {
        opacity: 1,
        strokeDashoffset: 0,
        duration: 0.82,
        stagger: { each: 0.08, from: "center" },
        ease: "power2.inOut"
      }, 0.58)
      .to(streams, { opacity: 0, duration: 0.22 }, 1.05)
      .to(".formationCore", { opacity: 1, scale: 1, duration: 0.48, ease: "back.out(1.7)" }, 1.04)
      .to(".formationLogoImage", {
        opacity: 1,
        scale: 1,
        filter: "blur(0px) brightness(1.05)",
        duration: 0.5,
        ease: "power2.out"
      }, 1.22)
      .to(".formationSvg", { opacity: 0.18, duration: 0.28 }, 1.45)
      .to(".formationSvg", { opacity: 0, duration: 0.5, ease: "power2.inOut" }, 1.74)
      .to(".formationLogoImage", { filter: "blur(0px) brightness(1)", duration: 0.42 }, 1.8);

    FORMATION_BEAMS.forEach((beam, index) => {
      timeline
        .to(`.formationParticle--${beam.id}`, { opacity: 1, duration: 0.1, stagger: 0.018 }, 0.16 + index * 0.018)
        .to(`.formationParticle--${beam.id}`, {
          motionPath: {
            path: `.formationPath--${beam.id}`,
            align: `.formationPath--${beam.id}`,
            alignOrigin: [0.5, 0.5],
            autoRotate: false,
            start: 0,
            end: 1
          },
          opacity: 0,
          scale: 0.16,
          duration: 0.9,
          stagger: { each: 0.045, from: "random" },
          ease: "power3.in"
        }, 0.2 + index * 0.024);
    });
  }, { scope: sceneRef });

  return (
    <span
      ref={sceneRef}
      className={`logoFormationScene logoFormationScene-${mood} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : "true"}
    >
      <svg className="formationSvg" viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <linearGradient id={beamGradientId} x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#fff5c2" stopOpacity="0" />
            <stop offset="28%" stopColor="#fff5c2" />
            <stop offset="58%" stopColor="#f5b942" />
            <stop offset="100%" stopColor="#f28a2e" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={cellGradientId} x1="18%" x2="82%" y1="12%" y2="92%">
            <stop offset="0%" stopColor="#fff2a9" />
            <stop offset="52%" stopColor="#f7be42" />
            <stop offset="100%" stopColor="#d9851e" />
          </linearGradient>
          <radialGradient id={coreGradientId} cx="50%" cy="50%" r="64%">
            <stop offset="0%" stopColor="#fffaf0" />
            <stop offset="72%" stopColor="#f7ead0" />
            <stop offset="100%" stopColor="#f1d7a8" />
          </radialGradient>
          <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4.2" result="blur" />
            <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0.95 0 1 0 0 0.62 0 0 1 0 0.1 0 0 0 1 0" result="warmGlow" />
            <feMerge>
              <feMergeNode in="warmGlow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="formationBeamLayer">
          {FORMATION_BEAMS.map((beam) => (
            <path key={`path-${beam.id}`} className={`formationPath formationPath--${beam.id}`} d={beam.d} />
          ))}
          {FORMATION_BEAMS.map((beam) => (
            <path key={`stream-${beam.id}`} className="formationStream" d={beam.d} pathLength={1} stroke={`url(#${beamGradientId})`} />
          ))}
          {FORMATION_BEAMS.flatMap((beam) => (
            Array.from({ length: beam.count }, (_, index) => (
              <circle
                key={`${beam.id}-${index}`}
                className={`formationParticle formationParticle--${beam.id}`}
                cx="0"
                cy="0"
                r={index % 3 === 0 ? 2.5 : 1.8}
                fill={index % 2 === 0 ? "#fff3bb" : "#f5b942"}
              />
            ))
          ))}
        </g>
        <circle className="formationPulse" cx="110" cy="112" r="72" fill="#f5b942" />
        <g className="formationMark" filter={`url(#${glowId})`}>
          {FORMATION_CELLS.map((cell) => (
            <path
              key={cell.id}
              className={`formationCell formationCell--${cell.id}`}
              d={cell.d}
              pathLength={1}
              fill="none"
              stroke={`url(#${cellGradientId})`}
              strokeWidth="12"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          <path className="formationCore" d={CORE_PATH} fill={`url(#${coreGradientId})`} stroke="#fff5df" strokeWidth="3" />
        </g>
      </svg>
      <img className="formationLogoImage" src={honeycombLogoUrl} alt={alt} draggable={false} />
    </span>
  );
}

export default LogoFormationScene;
