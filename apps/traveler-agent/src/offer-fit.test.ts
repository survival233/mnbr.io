import { describe, expect, it } from "vitest";
import { offerBelongsToTraveler } from "./offer-fit.mts";

describe("offerBelongsToTraveler", () => {
  it("matches only the offered traveler id", () => {
    expect(offerBelongsToTraveler({ travelerId: "usr_ada" }, "usr_ada")).toBe(true);
    expect(offerBelongsToTraveler({ travelerId: "usr_ada" }, "usr_ben")).toBe(false);
    expect(offerBelongsToTraveler({ travelerId: null }, "usr_ada")).toBe(false);
    expect(offerBelongsToTraveler({}, "usr_ada")).toBe(false);
  });
});
