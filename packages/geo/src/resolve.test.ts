import { describe, expect, it } from "vitest";
import { resolveMetro, resolveHub, hubCity, guestTown, sameMetro } from "./resolve";

describe("resolveMetro", () => {
  it("maps IATA, city, and airport name to one metro", () => {
    expect(resolveMetro("ACC")?.id).toBe("accra");
    expect(resolveMetro("Accra")?.id).toBe("accra");
    expect(resolveMetro("Kotoka")?.id).toBe("accra");
    expect(resolveMetro("JFK")?.id).toBe(resolveMetro("New York")?.id);
  });

  it("does not treat a different hub city as the same metro", () => {
    expect(sameMetro("Accra", "Kumasi")).toBe(false);
    expect(sameMetro("Lagos", "Accra")).toBe(false);
    expect(sameMetro("San José", "Buenos Aires")).toBe(false);
  });

  it("groups catchment towns with their hub airport", () => {
    expect(sameMetro("Tema", "Accra")).toBe(true);
    expect(sameMetro("Tema", "ACC")).toBe(true);
    expect(sameMetro("Brooklyn", "New York")).toBe(true);
    expect(sameMetro("Escazú", "SJO")).toBe(true);
    expect(sameMetro("Quilmes", "Buenos Aires")).toBe(true);
    expect(hubCity("Tema")).toBe("Accra");
    expect(guestTown("Tema")).toBe("Tema");
    expect(guestTown("ACC")).toBe("Accra");
    expect(resolveHub("Tema")?.id).toBe("accra");
    expect(resolveHub("Nairobi")?.id).toBe("nairobi");
    expect(resolveHub("Springfield")).toBeNull();
  });

  it("matches the same unknown city to itself", () => {
    expect(sameMetro("Nairobi", "nairobi")).toBe(true);
    expect(resolveMetro("Nairobi")?.city).toBe("Nairobi");
  });

  it("resolves San José and Buenos Aires", () => {
    expect(resolveMetro("SJO")?.id).toBe("san_jose");
    expect(sameMetro("San José", "SJO")).toBe(true);
    expect(resolveMetro("EZE")?.id).toBe("buenos_aires");
    expect(sameMetro("Buenos Aires", "AEP")).toBe(true);
  });
});
