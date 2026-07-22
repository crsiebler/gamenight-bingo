import type { ComponentPropsWithRef, ReactNode } from "react";

import { combineIds, controlStyle, FieldFrame, useFieldIds } from "./field.js";

export type InputProps = Omit<ComponentPropsWithRef<"input">, "aria-invalid"> & {
  description?: ReactNode;
  errorMessage?: ReactNode;
  label: ReactNode;
  leadingIcon?: ReactNode;
  "aria-invalid"?: boolean;
};

export function Input({
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  description,
  errorMessage,
  id: explicitId,
  label,
  leadingIcon,
  required,
  style,
  ...props
}: InputProps) {
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
      <div style={{ alignItems: "center", display: "flex", position: "relative" }}>
        {leadingIcon ? (
          <span
            aria-hidden="true"
            style={{ left: "0.75rem", pointerEvents: "none", position: "absolute" }}
          >
            {leadingIcon}
          </span>
        ) : null}
        <input
          {...props}
          aria-describedby={combineIds(describedBy, descriptionId, errorId)}
          aria-invalid={invalid || undefined}
          id={id}
          required={required}
          style={{
            ...controlStyle,
            borderColor: invalid ? "var(--bingo-border-danger, #b91c1c)" : controlStyle.borderColor,
            paddingLeft: leadingIcon ? "2.75rem" : controlStyle.paddingLeft,
            ...style,
          }}
        />
      </div>
    </FieldFrame>
  );
}
