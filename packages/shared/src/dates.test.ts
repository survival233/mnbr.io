import { describe, it, expect } from "vitest";
import { endOfLocalDay } from "./dates";

describe("endOfLocalDay", () => {
  it("sets local time to 23:59:59.999 on the same calendar day", () => {
    const d = endOfLocalDay(new Date(2026, 7, 15, 8, 30, 0));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it("is idempotent for an already end-of-day value", () => {
    const once = endOfLocalDay(new Date(2026, 7, 15));
    expect(endOfLocalDay(once).getTime()).toBe(once.getTime());
  });
});
