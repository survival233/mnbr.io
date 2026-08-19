import { describe, expect, it } from "vitest";
import { parseItem } from "./item";

describe("parseItem — product only, never the utterance", () => {
  it("returns null for shop intent without a named product", () => {
    expect(parseItem("I want to shop")).toBeNull();
    expect(parseItem("hello I want to shop")).toBeNull();
    expect(parseItem("can you help me shop")).toBeNull();
    expect(parseItem("shop for me")).toBeNull();
    expect(parseItem("something")).toBeNull();
  });

  it("extracts a concrete product from a request shell", () => {
    expect(parseItem("get me a PS5")).toBe("PS5");
    expect(parseItem("I want AirPods Pro")).toMatch(/AirPods Pro/i);
    expect(parseItem("hoodie")).toBe("hoodie");
  });

  it("keeps only the product when it sits inside other words", () => {
    expect(parseItem("I want you to shop me a PS5 from the US")).toMatch(/^PS5$/i);
  });

  it("does not treat a city or date as an item", () => {
    expect(parseItem("New York")).toBeNull();
    expect(parseItem("tomorrow")).toBeNull();
  });
});
