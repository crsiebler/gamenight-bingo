import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import Link from "next/link";

export type LinkButtonProps = ComponentPropsWithoutRef<typeof Link>;

const linkStyle: CSSProperties = {
  alignItems: "center",
  backgroundColor: "var(--bingo-action-primary, #1d4ed8)",
  border: "2px solid var(--bingo-action-primary, #1d4ed8)",
  borderRadius: "0.5rem",
  boxSizing: "border-box",
  color: "var(--bingo-action-on-solid, #ffffff)",
  display: "inline-flex",
  fontWeight: 700,
  justifyContent: "center",
  minHeight: "2.75rem",
  padding: "0.625rem 1rem",
  textAlign: "center",
  textDecoration: "none",
};

export function LinkButton({ rel, style, target, ...props }: LinkButtonProps) {
  const safeRel =
    target === "_blank"
      ? [...new Set([...(rel?.split(/\s+/).filter(Boolean) ?? []), "noopener", "noreferrer"])].join(
          " ",
        )
      : rel;

  return <Link {...props} rel={safeRel} style={{ ...linkStyle, ...style }} target={target} />;
}
