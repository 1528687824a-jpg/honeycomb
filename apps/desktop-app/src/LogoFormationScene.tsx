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
  { id: "entryRight", d: "M396 154 C326 139 278 146 242 176 C211 202 171 199 132 178", delay: 0.5, duration: 1.28 },
  { id: "upperRibbon", d: "M350 42 C276 38 228 76 218 130 C209 178 174 190 126 174", delay: 0.62, duration: 1.22 },
  { id: "outerLoop", d: "M392 94 C329 20 201 34 145 116 C92 194 155 286 264 260 C347 240 392 186 360 134", delay: 0.72, duration: 1.48 },
  { id: "lowerLoop", d: "M-58 236 C38 320 178 304 254 226 C309 169 351 169 412 192", delay: 0.86, duration: 1.34 },
  { id: "leftCurl", d: "M-44 124 C54 72 116 118 158 158 C198 197 235 194 302 158", delay: 0.94, duration: 1.24 },
  { id: "topDrop", d: "M170 -48 C222 18 194 78 208 128 C221 178 185 202 132 178", delay: 1.18, duration: 1.18 },
  { id: "cellGuide", d: "M76 214 C93 188 115 179 142 185 C168 190 187 179 207 153 C228 126 252 114 292 111", delay: 1.3, duration: 1.05 }
] as const;

const LOGO_CELLS = [
  { id: "top", cx: 180, cy: 124, r: 58 },
  { id: "left", cx: 122, cy: 222, r: 58 },
  { id: "right", cx: 238, cy: 222, r: 58 }
] as const;

function hexPoints(cx: number, cy: number, radius: number) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (index * 60);
    return `${(cx + Math.cos(angle) * radius).toFixed(1)},${(cy + Math.sin(angle) * radius).toFixed(1)}`;
  }).join(" ");
}

export function LogoFormationScene({
  size = 172,
  className = "",
  alt = "",
  mood = "asking"
}: LogoFormationSceneProps) {
  const sceneRef = useRef<HTMLSpanElement | null>(null);
  const rawId = useId().replace(/:/g, "");
  const auraGradientId = `formationAura-${rawId}`;
  const ribbonGradientId = `formationRibbon-${rawId}`;
  const coreGradientId = `formationCore-${rawId}`;
  const bloomGradientId = `formationBloom-${rawId}`;
  const logoGlowId = `formationLogoGlow-${rawId}`;

  useGSAP(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const q = gsap.utils.selector(scene);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ambient = q<HTMLSpanElement>(".formationAmbient");
    const centerGlow = q<HTMLSpanElement>(".formationCenterGlow");
    const bloom = q<SVGCircleElement>(".formationBloom");
    const streamLayer = q<SVGGElement>(".formationStreamLayer");
    const streamAuras = q<SVGPathElement>(".formationStream-aura");
    const streamRibbons = q<SVGPathElement>(".formationStream-ribbon");
    const streamCores = q<SVGPathElement>(".formationStream-core");
    const sparkCloud = q<SVGGElement>(".formationSparkCloud");
    const logoGroup = q<SVGGElement>(".formationVectorLogo");
    const logoFills = q<SVGPolygonElement>(".formationLogoFill");
    const logoStrokes = q<SVGPolygonElement>(".formationLogoStroke");
    const logoInnerStrokes = q<SVGPolygonElement>(".formationLogoInnerStroke");
    const logoCore = q<SVGPolygonElement>(".formationLogoCore");
    const logoCoreShadow = q<SVGPolygonElement>(".formationLogoCoreShadow");
    const fallbackLogo = q<HTMLImageElement>(".formationLogoImage");

    gsap.set([ambient, centerGlow], { opacity: 0, scale: 0.64, transformOrigin: "50% 50%" });
    gsap.set(bloom, { opacity: 0, scale: 0.7, transformOrigin: "50% 50%" });
    gsap.set(streamLayer, { opacity: 1, rotation: -7, transformOrigin: "50% 50%" });
    gsap.set([streamAuras, streamRibbons], {
      opacity: 0,
      strokeDasharray: 1,
      strokeDashoffset: 1,
      transformOrigin: "50% 50%"
    });
    gsap.set(streamCores, {
      opacity: 0,
      strokeDasharray: "0.1 0.22",
      strokeDashoffset: 1.08,
      transformOrigin: "50% 50%"
    });
    gsap.set(sparkCloud, { opacity: 0, transformOrigin: "50% 50%" });
    gsap.set(logoGroup, { opacity: 0, scale: 0.92, transformOrigin: "50% 58%" });
    gsap.set(logoFills, { opacity: 0 });
    gsap.set([logoStrokes, logoInnerStrokes], {
      opacity: 0,
      strokeDasharray: 1,
      strokeDashoffset: 1,
      transformOrigin: "50% 50%"
    });
    gsap.set([logoCore, logoCoreShadow], { opacity: 0, scale: 0.72, transformOrigin: "50% 50%" });
    gsap.set(fallbackLogo, {
      opacity: 0,
      scale: 0.98,
      filter: "blur(6px) brightness(1.18)",
      transformOrigin: "50% 50%"
    });

    if (mood !== "asking") {
      gsap.set([ambient, centerGlow, bloom, streamLayer, sparkCloud, logoGroup], { opacity: 0 });
      gsap.set(fallbackLogo, {
        opacity: 1,
        scale: 1,
        filter: "drop-shadow(0 0 28px rgba(245, 185, 66, 0.52)) brightness(1)",
        transformOrigin: "50% 50%"
      });
      return;
    }

    if (reducedMotion) {
      gsap.set([streamAuras, streamRibbons, streamCores, sparkCloud], { opacity: 0 });
      gsap.set(ambient, { opacity: 0.42, scale: 1.05 });
      gsap.set(centerGlow, { opacity: 0.18, scale: 1.04 });
      gsap.set(bloom, { opacity: 0.2, scale: 1.08 });
      gsap.set(logoGroup, { opacity: 1, scale: 1 });
      gsap.set(logoFills, { opacity: 0.68 });
      gsap.set([logoStrokes, logoInnerStrokes], { opacity: 1, strokeDashoffset: 0 });
      gsap.set([logoCore, logoCoreShadow], { opacity: 1, scale: 1 });
      return;
    }

    const timeline = gsap.timeline({ defaults: { ease: "sine.out" } });

    timeline
      .to(ambient, { opacity: 0.2, scale: 0.78, duration: 0.42 }, 0)
      .to(centerGlow, { opacity: 0.14, scale: 0.72, duration: 0.46 }, 0.06)
      .to(bloom, { opacity: 0.18, scale: 0.86, duration: 0.48 }, 0.08)
      .to(ambient, { opacity: 0.42, scale: 1.08, duration: 1.25, ease: "sine.inOut" }, 0.52)
      .to(centerGlow, { opacity: 0.28, scale: 1.18, duration: 1.12, ease: "sine.inOut" }, 0.72)
      .to(bloom, { opacity: 0.34, scale: 1.16, duration: 1.1, ease: "sine.inOut" }, 0.78)
      .to(streamLayer, { rotation: 13, duration: 2.05, ease: "power1.inOut" }, 0.58);

    SWIRL_STREAMS.forEach((stream, index) => {
      const selector = `.formationStream--${stream.id}`;
      timeline
        .to(`${selector}.formationStream-aura`, {
          opacity: index < 3 ? 0.46 : 0.34,
          duration: 0.18,
          ease: "sine.out"
        }, stream.delay)
        .to(`${selector}.formationStream-aura`, {
          strokeDashoffset: 0,
          duration: stream.duration,
          ease: "power3.inOut"
        }, stream.delay)
        .to(`${selector}.formationStream-ribbon`, {
          opacity: index < 3 ? 0.82 : 0.62,
          duration: 0.18,
          ease: "sine.out"
        }, stream.delay + 0.03)
        .to(`${selector}.formationStream-ribbon`, {
          strokeDashoffset: 0,
          duration: stream.duration,
          ease: "power3.inOut"
        }, stream.delay + 0.03)
        .to(`${selector}.formationStream-core`, {
          opacity: index < 4 ? 1 : 0.72,
          duration: 0.16,
          ease: "sine.out"
        }, stream.delay + 0.08)
        .to(`${selector}.formationStream-core`, {
          strokeDashoffset: -3.6,
          duration: stream.duration + 0.5,
          ease: "none"
        }, stream.delay + 0.08);
    });

    timeline
      .to(sparkCloud, { opacity: 0.75, duration: 0.18 }, 1.25)
      .to(sparkCloud, { opacity: 0, duration: 0.9, ease: "sine.inOut" }, 1.72)
      .to(logoGroup, { opacity: 1, scale: 1, duration: 0.42, ease: "sine.out" }, 1.78)
      .to(logoStrokes, {
        opacity: 1,
        strokeDashoffset: 0,
        duration: 0.52,
        ease: "power2.inOut",
        stagger: { each: 0.05, from: "center" }
      }, 1.82)
      .to(logoInnerStrokes, {
        opacity: 1,
        strokeDashoffset: 0,
        duration: 0.5,
        ease: "power2.inOut",
        stagger: { each: 0.05, from: "center" }
      }, 1.94)
      .to(logoFills, {
        opacity: 0.68,
        duration: 0.52,
        ease: "sine.inOut",
        stagger: { each: 0.04, from: "center" }
      }, 2.08)
      .to([logoCoreShadow, logoCore], {
        opacity: 1,
        scale: 1,
        duration: 0.5,
        ease: "back.out(1.6)"
      }, 2.24)
      .to([streamAuras, streamRibbons], {
        opacity: 0,
        duration: 0.58,
        ease: "sine.inOut",
        overwrite: "auto",
        stagger: 0.008
      }, 2.2)
      .to(streamCores, {
        opacity: 0,
        duration: 0.5,
        ease: "sine.inOut",
        overwrite: "auto",
        stagger: 0.008
      }, 2.34)
      .to(bloom, { opacity: 0.18, scale: 1.04, duration: 0.74, ease: "sine.inOut" }, 2.42)
      .to(centerGlow, {
        opacity: 0.18,
        scale: 1.03,
        duration: 1.65,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      }, 2.6)
      .to(ambient, {
        opacity: 0.44,
        scale: 1.1,
        duration: 1.9,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      }, 2.6);
  }, { scope: sceneRef, dependencies: [mood], revertOnUpdate: true });

  return (
    <span
      ref={sceneRef}
      className={`logoFormationScene logoFormationScene-${mood} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : "true"}
    >
      {mood === "asking" ? (
        <>
          <span className="formationAmbient" aria-hidden="true" />
          <span className="formationCenterGlow" aria-hidden="true" />
          <svg className="formationSvg" viewBox="-40 -40 440 440" aria-hidden="true">
            <defs>
              <radialGradient id={bloomGradientId} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#fff2b5" stopOpacity="0.9" />
                <stop offset="36%" stopColor="#f5b942" stopOpacity="0.42" />
                <stop offset="100%" stopColor="#f5b942" stopOpacity="0" />
              </radialGradient>
              <linearGradient id={auraGradientId} x1="100%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="#ffd675" stopOpacity="0.18" />
                <stop offset="48%" stopColor="#f5b942" stopOpacity="0.62" />
                <stop offset="100%" stopColor="#f28a2e" stopOpacity="0.12" />
              </linearGradient>
              <linearGradient id={ribbonGradientId} x1="100%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="#fff4b7" stopOpacity="0.24" />
                <stop offset="22%" stopColor="#fff4b7" stopOpacity="0.96" />
                <stop offset="58%" stopColor="#f5b942" stopOpacity="0.86" />
                <stop offset="100%" stopColor="#f28a2e" stopOpacity="0.2" />
              </linearGradient>
              <linearGradient id={coreGradientId} x1="100%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="#fffbe0" stopOpacity="0" />
                <stop offset="44%" stopColor="#fffbe0" />
                <stop offset="78%" stopColor="#f5b942" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#f5b942" stopOpacity="0" />
              </linearGradient>
              <filter id={logoGlowId} x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
                <feColorMatrix
                  in="blur"
                  result="warmBlur"
                  values="1 0 0 0 0.96  0 0.72 0 0 0.48  0 0 0.2 0 0.1  0 0 0 0.75 0"
                />
                <feMerge>
                  <feMergeNode in="warmBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <circle className="formationBloom" cx="180" cy="182" r="98" fill={`url(#${bloomGradientId})`} />
            <g className="formationStreamLayer">
              {SWIRL_STREAMS.map((stream) => (
                <path
                  key={`aura-${stream.id}`}
                  className={`formationStream formationStream-aura formationStream--${stream.id}`}
                  d={stream.d}
                  pathLength={1}
                  stroke={`url(#${auraGradientId})`}
                />
              ))}
              {SWIRL_STREAMS.map((stream) => (
                <path
                  key={`ribbon-${stream.id}`}
                  className={`formationStream formationStream-ribbon formationStream--${stream.id}`}
                  d={stream.d}
                  pathLength={1}
                  stroke={`url(#${ribbonGradientId})`}
                />
              ))}
              {SWIRL_STREAMS.map((stream) => (
                <path
                  key={`core-${stream.id}`}
                  className={`formationStream formationStream-core formationStream--${stream.id}`}
                  d={stream.d}
                  pathLength={1}
                  stroke={`url(#${coreGradientId})`}
                />
              ))}
            </g>
            <g className="formationSparkCloud">
              {Array.from({ length: 24 }, (_, index) => {
                const angle = index * 0.82;
                const radius = 62 + (index % 5) * 12;
                const cx = 180 + Math.cos(angle) * radius;
                const cy = 183 + Math.sin(angle) * radius * 0.72;
                return (
                  <circle
                    key={index}
                    className="formationSpark"
                    cx={cx.toFixed(1)}
                    cy={cy.toFixed(1)}
                    r={index % 4 === 0 ? 1.6 : 1}
                  />
                );
              })}
            </g>
            <g className="formationVectorLogo" filter={`url(#${logoGlowId})`}>
              {LOGO_CELLS.map((cell) => (
                <g key={cell.id}>
                  <polygon className="formationLogoFill" points={hexPoints(cell.cx, cell.cy, cell.r - 13)} />
                  <polygon className="formationLogoStroke" points={hexPoints(cell.cx, cell.cy, cell.r)} pathLength={1} />
                  <polygon className="formationLogoInnerStroke" points={hexPoints(cell.cx, cell.cy, cell.r - 13)} pathLength={1} />
                </g>
              ))}
              <polygon className="formationLogoCoreShadow" points={hexPoints(180, 180, 42)} />
              <polygon className="formationLogoCore" points={hexPoints(180, 180, 38)} />
            </g>
          </svg>
        </>
      ) : (
        <img className="formationLogoImage" src={honeycombLogoUrl} alt={alt} draggable={false} />
      )}
    </span>
  );
}

export default LogoFormationScene;
