import { useId, type CSSProperties, type ReactNode } from "react";

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "0.375rem",
  width: "100%",
};

const labelStyle: CSSProperties = {
  fontSize: "0.9375rem",
  fontWeight: 700,
};

export const controlStyle: CSSProperties = {
  backgroundColor: "Canvas",
  border: "2px solid var(--bingo-border-control, #64748b)",
  borderRadius: "0.5rem",
  boxSizing: "border-box",
  color: "CanvasText",
  font: "inherit",
  minHeight: "2.75rem",
  padding: "0.625rem 0.75rem",
  width: "100%",
};

export function combineIds(...ids: Array<string | undefined>): string | undefined {
  const combined = ids.filter((id): id is string => Boolean(id)).join(" ");
  return combined || undefined;
}

export function useFieldIds(
  explicitId: string | undefined,
  hasDescription: boolean,
  hasError: boolean,
) {
  const reactId = useId();
  const id = explicitId ?? `field-${reactId.replaceAll(":", "")}`;

  return {
    id,
    descriptionId: hasDescription ? `${id}-description` : undefined,
    errorId: hasError ? `${id}-error` : undefined,
  };
}

type FieldFrameProps = {
  children: ReactNode;
  description?: ReactNode;
  descriptionId?: string | undefined;
  errorId?: string | undefined;
  errorMessage?: ReactNode;
  id: string;
  label: ReactNode;
  required?: boolean | undefined;
};

export function FieldFrame({
  children,
  description,
  descriptionId,
  errorId,
  errorMessage,
  id,
  label,
  required,
}: FieldFrameProps) {
  return (
    <div style={fieldStyle}>
      <label htmlFor={id} style={labelStyle}>
        {label}
        {required ? " (required)" : null}
      </label>
      {children}
      {description ? (
        <span
          id={descriptionId}
          style={{ color: "var(--bingo-text-muted, #475569)", fontSize: "0.875rem" }}
        >
          {description}
        </span>
      ) : null}
      {errorMessage ? (
        <span
          id={errorId}
          role="alert"
          style={{
            color: "var(--bingo-text-danger, #b91c1c)",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
