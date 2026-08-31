import { describe, expect, it } from "vitest";
import { extractHttpUrl } from "./product-url.mts";

describe("extractHttpUrl", () => {
  it("pulls a pasted store URL out of a sentence", () => {
    expect(extractHttpUrl("https://www.apple.com/shop/buy-airpods/airpods-pro")).toBe(
      "https://www.apple.com/shop/buy-airpods/airpods-pro",
    );
    expect(extractHttpUrl("this one https://www.target.com/p/foo.")).toBe("https://www.target.com/p/foo");
    expect(extractHttpUrl("AirPods Pro")).toBeNull();
  });
});
