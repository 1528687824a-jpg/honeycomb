import honeycombLogoUrl from "./assets/honeycomb-logo.png";
import jimengLogoFormationUrl from "./assets/jimeng-logo-formation.mp4";

type LogoFormationSceneProps = {
  size?: number;
  className?: string;
  alt?: string;
  mood?: "asking" | "sad" | "happy";
};

export function LogoFormationScene({
  size = 172,
  className = "",
  alt = "",
  mood = "asking"
}: LogoFormationSceneProps) {
  return (
    <span
      className={`logoFormationScene logoFormationScene-${mood} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : "true"}
    >
      {mood === "asking" ? (
        <video
          className="formationVideo"
          src={jimengLogoFormationUrl}
          autoPlay
          muted
          playsInline
          preload="auto"
          draggable={false}
          aria-label={alt}
        />
      ) : (
        <img className="formationLogoImage" src={honeycombLogoUrl} alt={alt} draggable={false} />
      )}
    </span>
  );
}

export default LogoFormationScene;
