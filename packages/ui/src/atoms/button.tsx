import type { ComponentPropsWithRef, CSSProperties } from "react";

type ButtonVariant = "solid" | "outline" | "plain";
type ButtonTone = "primary" | "neutral" | "danger";

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  tone?: ButtonTone;
  variant?: ButtonVariant;
};

const toneColors: Record<ButtonTone, string> = {
  primary: "var(--bingo-action-primary, #1d4ed8)",
  neutral: "var(--bingo-action-neutral, #334155)",
  danger: "var(--bingo-action-danger, #b91c1c)",
};

export function Button({
  disabled,
  style,
  tone = "primary",
  type = "button",
  variant = "solid",
  ...props
}: ButtonProps) {
  const color = toneColors[tone];
  const variantStyle: CSSProperties =
    variant === "solid"
      ? {
          backgroundColor: color,
          borderColor: color,
          color: "var(--bingo-action-on-solid, #ffffff)",
        }
      : variant === "outline"
        ? { backgroundColor: "transparent", borderColor: color, color }
        : { backgroundColor: "transparent", borderColor: "transparent", color };

  return (
    <button
      {...props}
      disabled={disabled}
      type={type}
      style={{
        alignItems: "center",
        borderRadius: "0.5rem",
        borderStyle: "solid",
        borderWidth: "2px",
        boxSizing: "border-box",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        font: "inherit",
        fontWeight: 700,
        justifyContent: "center",
        minHeight: "2.75rem",
        opacity: disabled ? 0.55 : 1,
        padding: "0.625rem 1rem",
        textAlign: "center",
        ...variantStyle,
        ...style,
      }}
    />
  );
}
