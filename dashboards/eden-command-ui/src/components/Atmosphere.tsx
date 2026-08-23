import { useMemo } from "react";

export default function Atmosphere() {
  const particles = useMemo(
    () =>
      Array.from({ length: 34 }, (_, i) => ({
        id: i,
        x: +((i * 37.3) % 100).toFixed(2),
        y: +((i * 61.7) % 100).toFixed(2),
        s: (i % 3) + 1,
        d: 16 + (i % 7) * 3,
        delay: +((i % 11) * 0.9).toFixed(1),
      })),
    []
  );

  return (
    <div className="atmosphere">
      <div className="starfield" />
      <div className="starfield layer2" />
      <div className="nebula a" />
      <div className="nebula b" />
      <div className="particle-field">
        {particles.map((p) => (
          <span
            key={p.id}
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.s,
              height: p.s,
              animationDuration: `${p.d}s`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </div>
      <div className="grid-floor-wrap">
        <div className="grid-floor" />
      </div>
      <div className="scanlines-overlay" />
      <div className="vignette" />
      <div className="scan-bar" />
    </div>
  );
}
