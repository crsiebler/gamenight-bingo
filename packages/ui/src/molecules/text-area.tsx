import type { ComponentPropsWithRef, ReactNode } from "react";

import { combineIds, controlStyle, FieldFrame, useFieldIds } from "./field.js";

export type TextAreaProps = Omit<ComponentPropsWithRef<"textarea">, "aria-invalid"> & {
  description?: ReactNode;
  errorMessage?: ReactNode;
  label: ReactNode;
  "aria-invalid"?: boolean;
};

export function TextArea({
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  description,
  errorMessage,
  id: explicitId,
  label,
  required,
  rows = 4,
  style,
  ...props
}: TextAreaProps) {
  const invalid = Boolean(errorMessage) || ariaInvalid === true;
  const { id, descriptionId, errorId } = useFieldIds(
    explicitId,
    Boolean(description),
    Boolean(errorMessage),
  );

  return (
    <FieldFrame
      description={description}
      descriptionId={descriptionId}
      errorId={errorId}
      errorMessage={errorMessage}
      id={id}
      label={label}
      required={required}
    >
      <textarea
        {...props}
        aria-describedby={combineIds(describedBy, descriptionId, errorId)}
        aria-invalid={invalid || undefined}
        id={id}
        required={required}
        rows={rows}
        style={{
          ...controlStyle,
          borderColor: invalid ? "var(--bingo-border-danger, #b91c1c)" : controlStyle.borderColor,
          minHeight: "7rem",
          resize: "vertical",
          ...style,
        }}
      />
    </FieldFrame>
  );
}
