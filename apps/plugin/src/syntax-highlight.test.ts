import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightTs, renderLineNumbers } from "./syntax-highlight.js";

describe("syntax-highlight", () => {
  it("highlights keywords, strings, and jsx tags", () => {
    const html = highlightTs(`import React from "react";\nexport function Box() {\n  return <div className="x">{children}</div>;\n}`);
    assert.match(html, /tok-keyword/);
    assert.match(html, /tok-string/);
    assert.match(html, /tok-tag/);
  });

  it("renders line numbers", () => {
    assert.equal(renderLineNumbers(3), "1\n2\n3");
  });
});
