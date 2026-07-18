import type { ComponentPropsWithRef, ReactNode } from "react";

import { combineIds, controlStyle, FieldFrame, useFieldIds } from "./field.js";

export type SelectProps = Omit<ComponentPropsWithRef<"select">, "aria-invalid"> & {
  description?: ReactNode;
  errorMessage?: ReactNode;
  label: ReactNode;
  "aria-invalid"?: boolean;
};

export function Select({
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  children,
  description,
  errorMessage,
  id: explicitId,
  label,
  required,
  style,
  ...props
}: SelectProps) {
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
      <select
        {...props}
        aria-describedby={combineIds(describedBy, descriptionId, errorId)}
        aria-invalid={invalid || undefined}
        id={id}
        required={required}
        style={{
          ...controlStyle,
          borderColor: invalid ? "var(--bingo-border-danger, #b91c1c)" : controlStyle.borderColor,
          ...style,
        }}
      >
        {children}
      </select>
    </FieldFrame>
  );
}
