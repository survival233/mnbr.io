import { describe, expect, it } from "vitest";
import { resolveMetro, sameMetro } from "./resolve";

describe("resolveMetro", () => {
  it("maps IATA, city, and airport name to one metro", () => {
    expect(resolveMetro("ACC")?.id).toBe("accra");
    expect(resolveMetro("Accra")?.id).toBe("accra");
    expect(resolveMetro("Kotoka")?.id).toBe("accra");
    expect(resolveMetro("JFK")?.id).toBe(resolveMetro("New York")?.id);
  });

  it("does not treat a different city as the same metro", () => {
    expect(sameMetro("Accra", "Kumasi")).toBe(false);
    expect(sameMetro("Lagos", "Accra")).toBe(false);
    expect(sameMetro("Accra", "Tema")).toBe(false);
  });

  it("matches the same unknown city to itself", () => {
    expect(sameMetro("Nairobi", "nairobi")).toBe(true);
    expect(resolveMetro("Nairobi")?.city).toBe("Nairobi");
  });
});
