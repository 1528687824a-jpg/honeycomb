import honeycombLogoUrl from "./assets/honeycomb-logo.png";

type HoneycombLogoProps = {
  size?: number;
  mode?: "idle" | "talking" | "thinking";
  className?: string;
  alt?: string;
};

export function HoneycombLogo({
  size = 28,
  mode = "idle",
  className = "",
  alt = ""
}: HoneycombLogoProps) {
  return (
    <span
      className={`honeycombLogo honeycombLogo-${mode} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : "true"}
    >
      <img src={honeycombLogoUrl} alt={alt} draggable={false} />
    </span>
  );
}
