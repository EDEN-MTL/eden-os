import { ReactNode } from "react";

export default function HUDPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="hud-panel">
      <div className="hud-title">{title}</div>
      {children}
    </div>
  );
}
