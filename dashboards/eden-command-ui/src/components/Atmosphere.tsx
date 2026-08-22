import { useMemo } from "react";

export default function Atmosphere() {
  const particles = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => ({
        id: i,
        left: `${Math.random() * 100}%`,
        delay: `${Math.random() * 12}s`,
        duration: `${10 + Math.random() * 10}s`,
      })),
    []
  );

  return (
    <div className="atmosphere">
      <div className="particle-field">
        {particles.map((p) => (
          <span
            key={p.id}
            style={{
              left: p.left,
              bottom: "-10px",
              animationDelay: p.delay,
              animationDuration: p.duration,
            }}
          />
        ))}
      </div>
      <div className="grid-floor" />
      <div className="scanlines" />
      <div className="scan-bar" />
      <div className="vignette" />
    </div>
  );
}
