import { describe, expect, it } from "vitest";
import { checkItem, allowedCategories } from "./index";

describe("checkItem (delegates to @manebra/shared categories.ts)", () => {
  it("allows a category on the direction's allowlist", () => {
    const v = checkItem("electronics", "us_to_gh");
    expect(v.disposition).toBe("allow");
    expect(v.ok).toBe(true);
  });

  it("denies a category not allowed for the direction", () => {
    // electronics is us_to_gh only, not gh_to_us
    const v = checkItem("electronics", "gh_to_us");
    expect(v.disposition).toBe("deny");
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("category_not_allowed_for_direction");
  });

  it("flags an always-review category (foodstuffs) even though it is allowed", () => {
    const v = checkItem("foodstuffs_cbp_permitted", "gh_to_us");
    expect(v.disposition).toBe("flag");
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("always_review_category");
  });

  it("denies an unknown category", () => {
    expect(checkItem("weapons", "us_to_gh").disposition).toBe("deny");
  });
});

describe("allowedCategories", () => {
  it("lists the direction's eligible categories", () => {
    expect(allowedCategories("us_to_gh")).toContain("clothing_shoes");
    expect(allowedCategories("gh_to_us")).toContain("textiles_kente");
  });
});
