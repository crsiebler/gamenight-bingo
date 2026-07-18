import { createRef, type ComponentType, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as rootModule from "@";
import * as atomsModule from "@/atoms";
import * as libModule from "@/lib";
import * as moleculesModule from "@/molecules";
import * as organismsModule from "@/organisms";
import * as templatesModule from "@/templates";

type FoundationComponent = ComponentType<Record<string, unknown> & { children?: ReactNode }>;

function getComponent(module: Record<string, unknown>, name: string): FoundationComponent {
  const component = module[name];
  expect(component, `${name} must be exported`).toBeTypeOf("function");
  return component as FoundationComponent;
}

describe("accessible UI foundations", () => {
  it("resolves the app root and layer aliases", () => {
    expect(rootModule.Button).toBe(atomsModule.Button);
    expect(rootModule.Input).toBe(moleculesModule.Input);
    expect(libModule).toBeDefined();
    expect(organismsModule).toBeDefined();
    expect(templatesModule).toBeDefined();
  });

  it("renders buttons with safe native defaults and disabled behavior", () => {
    const Button = getComponent(atomsModule, "Button");
    const handleClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();

    render(
      <Button ref={ref} onClick={handleClick}>
        Call next
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Call next" });
    expect(button).toHaveAttribute("type", "button");
    expect(ref.current).toBe(button);
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledOnce();

    render(
      <Button disabled onClick={handleClick}>
        Disabled action
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disabled action" }));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("keeps text appearance separate from document semantics", () => {
    const Text = getComponent(atomsModule, "Text");

    render(
      <Text as="h2" variant="body">
        Game setup
      </Text>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Game setup" })).toBeVisible();
  });

  it("associates input labels, requirements, guidance, and errors", () => {
    const Input = getComponent(moleculesModule, "Input");

    render(
      <Input
        description="Shown to this lobby only."
        errorMessage="Enter a display name."
        id="host-name"
        label="Host name"
        name="hostName"
        required
      />,
    );

    const input = screen.getByLabelText("Host name (required)");
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Shown to this lobby only. Enter a display name.");
  });

  it("generates unique field identifiers without deriving them from labels", () => {
    const Input = getComponent(moleculesModule, "Input");

    render(
      <>
        <Input label="Player name" name="firstName" />
        <Input label="Player name" name="secondName" />
      </>,
    );

    const [first, second] = screen.getAllByLabelText("Player name");
    expect(first).toHaveAttribute("id");
    expect(second).toHaveAttribute("id");
    expect(first?.id).not.toBe(second?.id);
    expect(first?.id).not.toBe("player name");
  });

  it("announces an error added while the field remains mounted", () => {
    const Input = getComponent(moleculesModule, "Input");
    const view = render(<Input label="Lobby code" name="lobbyCode" />);

    expect(screen.queryByRole("alert")).toBeNull();

    view.rerender(
      <Input errorMessage="Enter a six-character code." label="Lobby code" name="lobbyCode" />,
    );

    const input = screen.getByLabelText("Lobby code");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a six-character code.");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a six-character code.");
  });

  it("preserves native textarea and select semantics", () => {
    const Option = getComponent(atomsModule, "Option");
    const Select = getComponent(moleculesModule, "Select");
    const TextArea = getComponent(moleculesModule, "TextArea");
    const handleChange = vi.fn();

    render(
      <>
        <TextArea label="Round note" name="note" rows={5} />
        <Select label="Call mode" name="callMode" onChange={handleChange}>
          <Option value="manual">Manual</Option>
          <Option value="automatic">Automatic</Option>
        </Select>
      </>,
    );

    expect(screen.getByLabelText("Round note")).toHaveAttribute("rows", "5");
    const select = screen.getByRole("combobox", { name: "Call mode" });
    fireEvent.change(select, { target: { value: "automatic" } });
    expect(select).toHaveValue("automatic");
    expect(handleChange).toHaveBeenCalledOnce();
  });

  it("renders button-styled navigation as one link", () => {
    const LinkButton = getComponent(atomsModule, "LinkButton");

    render(
      <LinkButton href="/join" rel="nofollow" target="_blank">
        Join a lobby
      </LinkButton>,
    );

    const link = screen.getByRole("link", { name: "Join a lobby" });
    expect(link).toHaveAttribute("href", "/join");
    expect(link).toHaveAttribute("rel", expect.stringContaining("nofollow"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(link.querySelector("button")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("serializes public JSON-LD without allowing script termination", () => {
    const JsonLd = getComponent(atomsModule, "JsonLd");
    const schema = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "GameNight </script><script>alert(1)</script>",
    };

    const { container } = render(<JsonLd schema={schema} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    expect(script?.innerHTML).not.toContain("<");
    expect(JSON.parse(script?.textContent ?? "null")).toEqual(schema);
  });
});
