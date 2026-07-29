import { createElement, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

type TextElement = "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "p" | "span";
type TextVariant = "display" | "heading" | "body" | "caption";
type TextWeight = "normal" | "medium" | "bold";

export type TextProps = HTMLAttributes<HTMLElement> & {
  as?: TextElement;
  children: ReactNode;
  variant?: TextVariant;
  weight?: TextWeight;
};

const variantStyles: Record<TextVariant, CSSProperties> = {
  display: { fontSize: "clamp(2.25rem, 7vw, 4.5rem)", lineHeight: 1 },
  heading: { fontSize: "clamp(1.5rem, 4vw, 2.25rem)", lineHeight: 1.15 },
  body: { fontSize: "1rem", lineHeight: 1.5 },
  caption: { fontSize: "0.875rem", lineHeight: 1.4 },
};

const weightStyles: Record<TextWeight, CSSProperties["fontWeight"]> = {
  normal: 400,
  medium: 600,
  bold: 800,
};

export function Text({
  as = "p",
  children,
  style,
  variant = "body",
  weight = "normal",
  ...props
}: TextProps) {
  return createElement(
    as,
    {
      ...props,
      style: {
        margin: 0,
        ...variantStyles[variant],
        fontWeight: weightStyles[weight],
        ...style,
      },
    },
    children,
  );
}
