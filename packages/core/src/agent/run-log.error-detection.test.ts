import { describe, it, expect } from "vitest";
import { inferRunLogToolIsError } from "./runner.js";

describe("inferRunLogToolIsError", () => {
  it("returns true when event explicitly marks error", () => {
    expect(inferRunLogToolIsError(true, undefined, null)).toBe(true);
  });

  it("returns true when details.error is present", () => {
    expect(
      inferRunLogToolIsError(
        false,
        "{\"error\":true}",
        { error: "Financial Datasets API error", message: "Invalid ticker" },
      ),
    ).toBe(true);
  });

  it("returns true when details.error_type uses boolean-like marker", () => {
    expect(inferRunLogToolIsError(false, undefined, { error_type: true })).toBe(true);
    expect(inferRunLogToolIsError(false, undefined, { error_type: "true" })).toBe(true);
  });

  it("returns true when text payload starts with error prefix", () => {
    expect(inferRunLogToolIsError(false, "error: ENOENT", null)).toBe(true);
  });

  it("returns false for successful tool responses", () => {
    expect(
      inferRunLogToolIsError(
        false,
        "{\"domain\":\"finance\",\"action\":\"get_financial_metrics\"}",
        { domain: "finance", action: "get_financial_metrics" },
      ),
    ).toBe(false);
  });
});
