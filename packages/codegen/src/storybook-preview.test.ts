import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  argsFromVariants,
  argsFromVariantSelection,
  buildTokenColorUtilityCss,
  collectCssVariableNames,
  defaultPreviewArgs,
  extractComponentName,
  extractInjectedTokenCss,
  extractTailwindColorClasses,
  extractHandlerPropNames,
  formatVariantSelectionLabel,
  parsePreviewVariantQuery,
  isDefaultExport,
  extractBareImportSpecifiers,
  buildTailwindConfigFromTokenCss,
  extractExistingPreviewMetadata,
  resolveInitialVariantSelection,
  extractCvaVariantAxes,
  extractCvaDefaultVariants,
  extractStoryArgTypeOptions,
  extractStoryDefaultArgs,
} from "./preview-utils.js";

describe("preview utils", () => {
  it("prefers the root export from a compound export block over sub-part forwardRef", () => {
    const source = `
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "./select";

const SelectTrigger = React.forwardRef((props, ref) => <button ref={ref} {...props} />);
const Select = SelectPrimitive.Root;
`;
    assert.equal(extractComponentName(source, "Select"), "Select");
  });

  it("prefers Form over FormItem forwardRef in compound files", () => {
    const source = `
export {
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormField,
};

const FormItem = React.forwardRef((props, ref) => <div ref={ref} {...props} />);
const Form = FormProvider;
`;
    assert.equal(extractComponentName(source, "Form"), "Form");
  });

  it("prefers Toast over ToastViewport forwardRef", () => {
    const source = `
export {
  ToastProps,
  ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
};

const ToastViewport = React.forwardRef((props, ref) => <div ref={ref} {...props} />);
const Toast = React.forwardRef((props, ref) => <div ref={ref} {...props} />);
`;
    assert.equal(extractComponentName(source, "Toast"), "Toast");
  });

  it("prefers forwardRef component bindings when extracting the component name", () => {
    assert.equal(
      extractComponentName(
        `
export interface InlineAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  type: string;
}

const helper = () => null;
export const InlineAlert = forwardRef<HTMLDivElement, InlineAlertProps>(
  ({ type, title, message }, ref) => <div ref={ref}>{title}</div>,
);
`,
        "Fallback",
      ),
      "InlineAlert",
    );
  });

  it("skips utility consts emitted before the component (shadcn-style buttonVariants)", () => {
    const source = `
import { cva } from "class-variance-authority";
import * as React from "react";

export const buttonVariants = cva("inline-flex items-center", {
  variants: { variant: { default: "bg-primary", outline: "border" } },
});

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, className, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant }), className)} {...props} />
  ),
);
`;
    assert.equal(extractComponentName(source, "Button"), "Button");
  });

  it("picks the PascalCase function component when no forwardRef/memo is present", () => {
    const source = `
export const tokenMap = { primary: "var(--primary)" };

export function Card(props: CardProps) {
  return <div className={tokenMap.primary}>{props.children}</div>;
}
`;
    assert.equal(extractComponentName(source, "Card"), "Card");
  });

  it("does not pick UPPER_SNAKE or lowercase utility consts", () => {
    const source = `
export const VARIANTS = { primary: "bg-primary" };
export const buttonStyles = "px-4";
export const Button = (props: ButtonProps) => <button {...props} />;
`;
    assert.equal(extractComponentName(source, "Button"), "Button");
  });

  it("falls back to provided name when nothing component-like is declared", () => {
    const source = `
const helper = () => null;
const buttonStyles = "px-4";
`;
    assert.equal(extractComponentName(source, "PreviewFallback"), "PreviewFallback");
  });

  it("detects default exports", () => {
    assert.equal(isDefaultExport("export default function Button() {}", "Button"), true);
    assert.equal(isDefaultExport("export default class Card {}", "Card"), true);
    assert.equal(isDefaultExport("export default Button;", "Button"), true);
    assert.equal(isDefaultExport("export function Button() {}", "Button"), false);
    assert.equal(isDefaultExport("export const Button = forwardRef(() => null);", "Button"), false);
  });

  it("extracts handler prop names for preview action stubs", () => {
    assert.deepEqual(
      extractHandlerPropNames(`
export interface AlertProps {
  onClose?: () => void;
}
export function Alert({ onClose, onDismiss }: AlertProps) {
  return <button onClick={onClose} />;
}
`),
      ["onClick", "onClose", "onDismiss"],
    );
  });

  it("maps figma variants to preview args", () => {
    assert.deepEqual(argsFromVariants({ type: ["Warning"], size: ["md"] }), {
      type: "Warning",
      size: "md",
    });
    assert.deepEqual(defaultPreviewArgs({
      componentName: "InlineAlert",
      storyFormat: "csf3",
      variants: { type: ["Warning"] },
      variantLabel: "type=Warning",
    }).type, "Warning");
  });

  it("parses preview variant query params safely", () => {
    const variants = { type: ["Warning", "Success"], size: ["sm", "md"] };

    assert.deepEqual(parsePreviewVariantQuery({ type: "Success", size: "md" }, variants), {
      type: "Success",
      size: "md",
    });
    assert.deepEqual(parsePreviewVariantQuery({ type: "Invalid" }, variants), {
      type: "Warning",
      size: "sm",
    });
    assert.deepEqual(
      argsFromVariantSelection(variants, { type: "Error", size: "lg" }),
      { type: "Warning", size: "sm" },
    );
    assert.equal(
      formatVariantSelectionLabel({ type: "Success", size: "md" }),
      "type=Success, size=md",
    );
  });

  it("extracts CVA variant axes and story defaults for existing components", () => {
    const componentContent = `
import * as React from "react";
import { cva } from "class-variance-authority";

const inlineAlertVariants = cva("flex gap-2", {
  variants: {
    type: {
      Warning: "bg-yellow",
      Success: "bg-green",
      Error: "bg-red",
    },
  },
  defaultVariants: {
    type: "Warning",
  },
});

export interface InlineAlertProps {
  width?: React.CSSProperties["width"];
  height?: React.CSSProperties["height"];
  showTitle?: boolean;
  title?: React.ReactNode;
  subtext?: React.ReactNode;
}

export const InlineAlert = React.forwardRef<HTMLDivElement, InlineAlertProps>(
  (
    {
      type = "Warning",
      showTitle = true,
      title = "Title",
      subtext = "Subtext",
      width,
      height,
    },
    ref,
  ) => (
    <div ref={ref} className={inlineAlertVariants({ type })}>
      {title}
      {subtext}
    </div>
  ),
);
`;

    const storyContent = `
const meta = {
  args: {
    type: "Success",
    title: "Title",
    subtext: "Subtext",
  },
  argTypes: {
    type: {
      control: "select",
      options: ["Warning", "Success", "Error", "Info", "Neutral"],
    },
    title: { control: "text" },
    subtext: { control: "text" },
    onClick: { action: "clicked" },
  },
};
`;

    assert.deepEqual(extractCvaVariantAxes(componentContent), {
      type: ["Warning", "Success", "Error"],
    });
    assert.deepEqual(extractCvaDefaultVariants(componentContent), {
      type: "Warning",
    });
    assert.deepEqual(extractStoryArgTypeOptions(storyContent), {
      type: ["Warning", "Success", "Error", "Info", "Neutral"],
    });
    assert.deepEqual(extractStoryDefaultArgs(storyContent), {
      type: "Success",
      title: "Title",
      subtext: "Subtext",
    });

    const metadata = extractExistingPreviewMetadata(componentContent, storyContent);
    assert.deepEqual(metadata.variants.type, [
      "Warning",
      "Success",
      "Error",
      "Info",
      "Neutral",
    ]);
    assert.equal(metadata.variantLabel, "type=Success");
    assert.deepEqual(
      metadata.propControls.map((control) => control.name),
      ["title", "subtext", "width", "height", "showTitle"],
    );

    assert.deepEqual(
      defaultPreviewArgs({
        componentName: "InlineAlert",
        storyFormat: "csf3",
        componentContent,
        storyContent,
        variants: metadata.variants,
        variantLabel: metadata.variantLabel,
      }),
      {
        type: "Success",
        showTitle: true,
        title: "Title",
        subtext: "Subtext",
        message: "Preview message",
        label: "Preview label",
        children: "InlineAlert",
      },
    );
  });

  it("extracts injectable CSS from mixed token excerpts", () => {
    const excerpt = `
import type { Config } from "tailwindcss";
export default { theme: { extend: { colors: { primary: "var(--color-bg-primary)" } } } };
:root {
  --color-bg-accent-yellow-default: rgb(255, 214, 0);
}
`;
    assert.match(extractInjectedTokenCss(excerpt), /--color-bg-accent-yellow-default: rgb\(255, 214, 0\)/);
    assert.doesNotMatch(extractInjectedTokenCss(excerpt), /import type/);
  });

  it("builds direct color utility CSS for token classes used in preview source", () => {
    const tokenCss = `
:root {
  --color-bg-accent-yellow-default: rgb(255, 214, 0);
  --color-text-primary-default: rgb(17, 24, 39);
}
`;
    const componentContent =
      'export function Badge() { return <div className="bg-color-bg-accent-yellow-default text-color-text-primary-default" />; }\n';

    assert.deepEqual(collectCssVariableNames(tokenCss), [
      "color-bg-accent-yellow-default",
      "color-text-primary-default",
    ]);
    assert.deepEqual(extractTailwindColorClasses(componentContent), [
      "bg-color-bg-accent-yellow-default",
      "text-color-text-primary-default",
    ]);

    const utilityCss = buildTokenColorUtilityCss(tokenCss, [componentContent]);
    assert.match(
      utilityCss,
      /\.bg-color-bg-accent-yellow-default \{ background-color: var\(--color-bg-accent-yellow-default\); \}/,
    );
    assert.match(
      utilityCss,
      /\.text-color-text-primary-default \{ color: var\(--color-text-primary-default\); \}/,
    );
  });

  it("extracts bare import specifiers from component source", () => {
    assert.deepEqual(
      extractBareImportSpecifiers(`
import { Dialog } from "@radix-ui/react-dialog";
import clsx from "clsx";
import { cn } from "../lib/utils";
import React from "react";
import { useState } from "react";
import "@/styles/globals.css";
`),
      ["@radix-ui/react-dialog", "clsx"],
    );
  });

  it("builds tailwind config from token CSS", () => {
    const tokenCss = `:root { --primary: #000; }`;
    const config = JSON.parse(buildTailwindConfigFromTokenCss(tokenCss, ["bg-primary"]));
    assert.deepEqual(config.safelist, ["bg-primary"]);
    assert.equal(config.theme.extend.colors["primary"], "var(--primary)");
  });
});
