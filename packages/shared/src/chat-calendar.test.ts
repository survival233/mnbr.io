import { describe, it, expect } from "vitest";
import { calendarText, calendarInput } from "./chat-calendar.js";
const now = new Date("2026-10-30T12:00:00Z");
describe("chat date picker", () => {
  it("shows a month grid and converts a day into the displayed month", () => {
    const state = {};
    expect(calendarText(state, now)).toContain("October 2026");
    expect(calendarInput(state, "31", now)).toEqual({ text: "2026-10-31", handled: false });
    calendarInput(state, "next month", now);
    expect(calendarText(state, now)).toContain("November 2026");
    expect(calendarInput(state, "1", now).text).toBe("2026-11-01");
  });
  it("rejects past and nonexistent days, including leap-day overflow", () => {
    expect(calendarInput({}, "29", now).handled).toBe(true);
    expect(calendarInput({ datePickerMonth: "2027-02" }, "29", now).error).toBeTruthy();
    expect(calendarInput({ datePickerMonth: "2028-02" }, "29", now).text).toBe("2028-02-29");
    expect(calendarInput({}, "0", now).error).toBeTruthy();
  });
  it("navigates over year boundaries and keeps free text unchanged", () => {
    const state = { datePickerMonth: "2026-12" };
    calendarInput(state, "next month", now);
    expect(state.datePickerMonth).toBe("2027-01");
    expect(calendarInput(state, "tomorrow", now)).toEqual({ text: "tomorrow", handled: false });
    calendarInput({}, "previous month", now);
    const current = {};
    calendarInput(current, "previous month", now);
    expect(calendarText(current, now)).toContain("October 2026");
  });
});
