import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  argsFromVariants,
  argsFromVariantSelection,
  buildStorybookPreviewHtml,
  buildTokenColorUtilityCss,
  collectCssVariableNames,
  defaultPreviewArgs,
  extractFirstStoryPreview,
  extractComponentName,
  extractInjectedTokenCss,
  extractTailwindColorClasses,
  extractImportBindings,
  extractHandlerPropNames,
  formatVariantSelectionLabel,
  parsePreviewVariantQuery,
  prepareComponentSource,
  preparePreviewBundle,
  resolveStoryPreviewTarget,
  prepareHotReloadComponentSource,
  buildHotReloadPreviewSource,
  parseInlineStyleString,
  stripCallTypeParameters,
} from "./storybook-preview.js";

function decodeEmbeddedPreviewSource(html: string): string {
  const match = html.match(/atob\("([^"]+)"\)/);
  if (!match?.[1]) {
    return "";
  }
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("storybook preview", () => {
  it("prepares component source for browser rendering", () => {
    const prepared = prepareComponentSource(
      "import React from 'react';\nexport function Button(props: ButtonProps) { return <button>{props.children}</button>; }\n",
    );
    assert.doesNotMatch(prepared, /import /);
    assert.match(prepared, /function Button/);
    assert.match(prepared, /const forwardRef = React.forwardRef/);
  });

  it("strips export statements from typical generated components", () => {
    const prepared = prepareComponentSource(`
export interface InlineAlertProps {
  type: "Warning" | "Error";
  title: string;
  message: string;
}

export function InlineAlert({ type, title, message }: InlineAlertProps) {
  return <div className="rounded border p-3">{title}: {message} ({type})</div>;
}

export default InlineAlert;
export { InlineAlert };
export type { InlineAlertProps };
`);
    assert.doesNotMatch(prepared, /\bexport\b/);
    assert.match(prepared, /function InlineAlert/);
  });

  it("strips interfaces that extend html attributes with jsdoc", () => {
    const prepared = prepareComponentSource(`
export interface InlineAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Figma: Alert type variant.
   */
  type: "Warning" | "Error";
  title: string;
  message: string;
}

export function InlineAlert({ type, title, message }: InlineAlertProps) {
  return <div className="rounded border p-3">{title}: {message} ({type})</div>;
}
`);
    assert.doesNotMatch(prepared, /\bexport\b/);
    assert.doesNotMatch(prepared, /\binterface\b/);
    assert.match(prepared, /function InlineAlert/);
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

  it("extracts icon imports for preview stubs", () => {
    assert.deepEqual(
      extractImportBindings(`
import { EtchCircleInfoIcon, EtchWarningIcon as WarningIcon } from "@/icons";
import type { InlineAlertProps } from "./types";
import * as Icons from "@/icons";
`),
      ["EtchCircleInfoIcon", "WarningIcon"],
    );
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

  it("converts html style strings to react style objects", () => {
    assert.deepEqual(parseInlineStyleString("color: red; margin-right: 8px"), {
      color: "red",
      marginRight: "8px",
    });

    const prepared = prepareComponentSource(`
export function Box() {
  return <div style="display: flex; background-color: #fff">Hello</div>;
}
`);
    assert.match(prepared, /style=\{\{ display: "flex", backgroundColor: "#fff" \}\}/);
    assert.doesNotMatch(prepared, /style="/);
  });

  it("stubs stripped icon imports in prepared preview source", () => {
    const prepared = prepareComponentSource(`
import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { EtchCircleInfoIcon } from "@/icons/etch";

export const InlineAlert = forwardRef(({ type, title, message, icon }, ref) => (
  <div ref={ref} className={cn("flex gap-2 rounded border p-3")}>
    {icon ?? <EtchCircleInfoIcon aria-hidden />}
    <span>{title}: {message} ({type})</span>
  </div>
));
`);
    assert.match(prepared, /const EtchCircleInfoIcon = createPreviewStub\("EtchCircleInfoIcon"\)/);
    assert.doesNotMatch(prepared, /from "@\/icons/);
  });

  it("inlines fetched icon modules instead of stubbing resolved bindings", () => {
    const prepared = preparePreviewBundle(
      `
import { EtchCircleInfoIcon } from "@/icons/etch";

export const InlineAlert = () => <EtchCircleInfoIcon aria-hidden />;
`,
      {
        dependencySources: [
          `const EtchCircleInfoIcon = forwardRef((props, ref) => (
  <svg ref={ref} viewBox="0 0 16 16" {...props}><circle cx="8" cy="8" r="6" /></svg>
));`,
        ],
        resolvedBindings: ["EtchCircleInfoIcon"],
      },
    );

    assert.match(prepared, /const EtchCircleInfoIcon = forwardRef/);
    assert.doesNotMatch(prepared, /createPreviewStub\("EtchCircleInfoIcon"\)/);
  });

  it("strips multiline imports and keeps forwardRef components", () => {
    const prepared = prepareComponentSource(`
import {
  forwardRef,
  type HTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, children }, ref) => (
    <button ref={ref} className={cn("px-3 py-2", className)}>{children}</button>
  ),
);
`);
    assert.doesNotMatch(prepared, /from "react"/);
    assert.match(prepared, /const Button = forwardRef/);
    assert.match(prepared, /className={cn\(/);
  });

  it("extracts story args from CSF3 stories", () => {
    const story = extractFirstStoryPreview(`
import type { StoryObj } from "@storybook/react";
export const Primary: Story = {
  args: { children: "Click me", variant: "primary" },
};
`);
    assert.equal(story?.storyName, "Primary");
    assert.equal(story?.args.children, "Click me");
  });

  it("builds preview html for component and story patches", () => {
    const html = buildStorybookPreviewHtml({
      componentName: "Button",
      storyFormat: "csf3",
      componentContent:
        "export function Button({ children }: { children: React.ReactNode }) { return <button>{children}</button>; }\n",
      storyContent: `export const Primary: Story = { args: { children: "Save" } };`,
      variantLabel: "Primary",
    });

    assert.ok(html);
    const previewSource = decodeEmbeddedPreviewSource(html ?? "");
    assert.match(previewSource, /PreviewErrorBoundary/);
    assert.match(html ?? "", /Primary/);
    assert.match(previewSource, /Save/);
    assert.match(html ?? "", /new Function\("React", "ReactDOM"/);
    assert.match(html ?? "", /atob\("/);
    assert.match(previewSource, /ensurePreviewHandlers\(__storyArgs, __handlerProps\)/);
    assert.match(previewSource, /fig2code-preview-action/);
  });

  it("builds preview html for forwardRef components", () => {
    const html = buildStorybookPreviewHtml({
      componentName: "InlineAlert",
      storyFormat: "csf3",
      variants: { type: ["Warning"] },
      componentContent: `
export interface InlineAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  type: "Warning" | "Error";
  title: string;
  message: string;
}

export const InlineAlert = forwardRef<HTMLDivElement, InlineAlertProps>(
  ({ type, title, message, className }, ref) => (
    <div ref={ref} className={cn("rounded border p-3", className)}>
      <strong>{title}</strong>: {message} ({type})
    </div>
  ),
);
`,
      variantLabel: "type=Warning",
    });

    assert.ok(html);
    const previewSource = decodeEmbeddedPreviewSource(html ?? "");
    assert.match(previewSource, /window\.__fig2codeComponent = InlineAlert/);
    assert.match(previewSource, /isPreviewComponent\(Component\)/);
    assert.doesNotMatch(previewSource, /forwardRef\s*</);
  });

  it("strips React.forwardRef generics that break babel preview compilation", () => {
    const prepared = prepareComponentSource(`
export interface InlineAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  type: "Warning" | "Error";
  title: string;
  message: string;
}

export const InlineAlert = React.forwardRef<HTMLDivElement, InlineAlertProps>(
  (
    {
      className,
      type,
      title,
      message,
    },
    ref,
  ) => (
    <div ref={ref} className={cn("rounded border p-3", className)}>
      {title}: {message} ({type})
    </div>
  ),
);
`);
    assert.match(prepared, /const InlineAlert = forwardRef\s*\(/);
    assert.doesNotMatch(prepared, /const InlineAlert = React\.forwardRef/);
    assert.doesNotMatch(prepared, /forwardRef\s*</);

    assert.equal(
      stripCallTypeParameters("const X = React.forwardRef<HTMLDivElement, Props>((props, ref) => null);"),
      "const X = React.forwardRef((props, ref) => null);",
    );
  });

  it("falls back to variant args when no story file exists", () => {
    const target = resolveStoryPreviewTarget({
      componentName: "InlineAlert",
      storyFormat: "csf3",
      variants: { type: ["Warning"] },
      componentContent:
        'export function InlineAlert({ type, title, message }: { type: string; title: string; message: string }) { return <div data-type={type}>{title}: {message}</div>; }\n',
      variantLabel: "type=Warning",
    });

    assert.equal(target?.storyName, "type=Warning");
    assert.equal(target?.componentName, "InlineAlert");
    assert.equal(target?.args.type, "Warning");
    assert.equal(target?.args.title, "Preview title");
    assert.equal(target?.args.message, "Preview message");
  });

  it("builds preview html with variant args for alert-like components", () => {
    const html = buildStorybookPreviewHtml({
      componentName: "InlineAlert",
      storyFormat: "csf3",
      variants: { type: ["Warning"] },
      componentContent:
        "export function InlineAlert({ type, title, message }) { return <div className=\"rounded border p-3\">{title}: {message} ({type})</div>; }\n",
      variantLabel: "type=Warning",
    });

    assert.ok(html);
    const previewSource = decodeEmbeddedPreviewSource(html ?? "");
    assert.match(previewSource, /Warning/);
    assert.match(previewSource, /PreviewErrorBoundary/);
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

  it("applies selected variant query args to preview html", () => {
    const preview = {
      componentName: "InlineAlert",
      storyFormat: "csf3" as const,
      variants: { type: ["Warning", "Success", "Error"] },
      componentContent:
        "export function InlineAlert({ type, title, message }) { return <div>{title}: {message} ({type})</div>; }\n",
      variantLabel: "type=Warning",
    };

    const warningTarget = resolveStoryPreviewTarget(preview, {
      selectedVariants: { type: "Warning" },
    });
    const successTarget = resolveStoryPreviewTarget(preview, {
      selectedVariants: { type: "Success" },
    });

    assert.equal(warningTarget?.args.type, "Warning");
    assert.equal(successTarget?.args.type, "Success");

    const html = buildStorybookPreviewHtml(preview, { sources: [], resolvedBindings: [] }, {
      selectedVariants: { type: "Success" },
    });

    assert.ok(html);
    const previewSource = decodeEmbeddedPreviewSource(html ?? "");
    assert.match(html ?? "", /type=Success/);
    assert.match(previewSource, /fig2code-preview-variants/);
    assert.match(previewSource, /__fig2codeUpdatePreviewVariants/);
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

  it("rebuilds preview source for hot reload while preserving runtime shims", () => {
    const originalComponent = `
export interface InlineAlertProps {
  type: "Warning" | "Error";
  title: string;
}

export function InlineAlert({ type, title }: InlineAlertProps) {
  return <div className="bg-color-bg-accent-yellow-default p-4">{title} ({type})</div>;
}
`;
    const editedComponent = `
export interface InlineAlertProps {
  type: "Warning" | "Error";
  title: string;
}

export function InlineAlert({ type, title }: InlineAlertProps) {
  return <div className="bg-color-bg-accent-yellow-default p-8 text-red-500">{title} ({type})</div>;
}
`;

    const html = buildStorybookPreviewHtml({
      componentName: "InlineAlert",
      storyFormat: "csf3",
      componentContent: originalComponent,
      variantLabel: "Default",
    });

    assert.ok(html);
    const previewSource = decodeEmbeddedPreviewSource(html ?? "");
    assert.match(previewSource, /\/\* __FIG2CODE_COMPONENT_START__ \*\//);
    assert.match(previewSource, /\/\* __FIG2CODE_COMPONENT_END__ \*\//);
    assert.match(previewSource, /function isPreviewComponent/);

    const reloaded = buildHotReloadPreviewSource(
      previewSource,
      editedComponent,
      "InlineAlert",
    );

    assert.match(reloaded, /function isPreviewComponent/);
    assert.match(reloaded, /p-8 text-red-500/);
    assert.doesNotMatch(reloaded, /\bexport\b/);
    assert.doesNotMatch(reloaded, /\bimport\b/);
    assert.match(reloaded, /window\.__fig2codeComponent = InlineAlert/);
    assert.match(reloaded, /function renderPreview/);
  });

  it("injects token CSS utilities into preview html", () => {
    const tokenCss = `
export default { theme: { extend: { colors: {} } } };
:root {
  --color-bg-accent-yellow-default: rgb(255, 214, 0);
}
`;
    const html = buildStorybookPreviewHtml(
      {
        componentName: "Badge",
        storyFormat: "csf3",
        componentContent:
          'export function Badge() { return <div className="bg-color-bg-accent-yellow-default p-4" />; }\n',
        variantLabel: "Default",
      },
      { sources: [], resolvedBindings: [] },
      { tokenCss },
    );

    assert.ok(html);
    assert.match(html ?? "", /--color-bg-accent-yellow-default: rgb\(255, 214, 0\)/);
    assert.match(
      html ?? "",
      /\.bg-color-bg-accent-yellow-default \{ background-color: var\(--color-bg-accent-yellow-default\); \}/,
    );
    assert.match(html ?? "", /"safelist":\["bg-color-bg-accent-yellow-default"\]/);
    assert.doesNotMatch(html ?? "", /export default \{ theme/);
  });
});
