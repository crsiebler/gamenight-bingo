import type { ComponentPropsWithoutRef } from "react";

export type OptionProps = ComponentPropsWithoutRef<"option">;

export function Option(props: OptionProps) {
  return <option {...props} />;
}
