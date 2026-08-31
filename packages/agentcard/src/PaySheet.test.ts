import { describe, expect, it } from "vitest";
import { paySheetUrl } from "./PaySheet";

describe("PaySheet amount is the recap total", () => {
  it("appends merchant + amount cents exactly", () => {
    const recapTotalCents = 12_345;
    const url = paySheetUrl("https://app.agentcard.sh/w/wl_test.token", "Manebra", recapTotalCents);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("amount")).toBe("12345");
    expect(parsed.searchParams.get("merchant")).toBe("Manebra");
  });

  it("rejects a non-recap amount", () => {
    expect(() => paySheetUrl("https://app.agentcard.sh/w/wl_x", "Manebra", 0)).toThrow(/recap total/);
  });
});
