// THROWAWAY — demonstrates that a failing test turns the required `ci`
// check red and blocks merging into main (Issue #21). Never merge this.
import { describe, expect, it } from "vitest";

describe("CI gate demo", () => {
  it("fails on purpose", () => {
    expect(1).toBe(2);
  });
});
