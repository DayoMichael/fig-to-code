import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  camelCase,
  parseVariantName,
  propertyBaseName,
  slugifyValue,
} from "./property-utils.js";

describe("property-utils", () => {
  it("strips figma property id suffixes", () => {
    assert.equal(propertyBaseName("Show Title#2184:0"), "Show Title");
    assert.equal(camelCase(propertyBaseName("Swap Icon#2184:12")), "swapIcon");
  });

  it("parses variant component names", () => {
    assert.deepEqual(parseVariantName("Type=Warning, Show Title=True"), {
      type: "Warning",
      showTitle: "True",
    });
  });

  it("slugifies style key values", () => {
    assert.equal(slugifyValue("Show Title"), "showtitle");
    assert.equal(slugifyValue("Warning"), "warning");
  });
});
