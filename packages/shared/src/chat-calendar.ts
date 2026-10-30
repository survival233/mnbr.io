export type ChatCalendarState = { datePickerMonth?: string };
function monthOf(now: Date): string { return now.toISOString().slice(0, 7); }
function parts(month: string): [number, number] { const [y, m] = month.split("-").map(Number); return [y!, m! - 1]; }
export function calendarText(state: ChatCalendarState, now = new Date()): string {
  const month = state.datePickerMonth ?? monthOf(now);
  state.datePickerMonth = month;
  const [year, m] = parts(month);
  const first = new Date(Date.UTC(year, m, 1));
  const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  const cells = Array<string>(first.getUTCDay()).fill("  ");
  for (let d = 1; d <= days; d++) cells.push(String(d).padStart(2));
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7).join(" "));
  return `${first.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}\n\`\`\`\nSu Mo Tu We Th Fr Sa\n${rows.join("\n")}\n\`\`\`\nReply with a day number, “next month”, or “previous month”. You can also type a full date (YYYY-MM-DD).`;
}
export function calendarInput(state: ChatCalendarState, input: string, now = new Date()): { text: string; handled: boolean; error?: string } {
  const value = input.trim().toLowerCase();
  const month = state.datePickerMonth ?? monthOf(now);
  if (/^(calendar|next month|previous month|prev month|this month)$/.test(value)) {
    const [year, m] = parts(month);
    const delta = value === "next month" ? 1 : /^(previous|prev)/.test(value) ? -1 : 0;
    const next = value === "this month" ? monthOf(now) : monthOf(new Date(Date.UTC(year, m + delta, 1)));
    state.datePickerMonth = next < monthOf(now) ? monthOf(now) : next;
    return { text: input, handled: true };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value + "T00:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < now.toISOString().slice(0, 10)) {
      return { text: input, handled: true, error: "Choose a valid date today or later." };
    }
  }
  if (!/^\d{1,2}$/.test(value)) return { text: input, handled: false };
  const [year, m] = parts(month);
  const day = Number(value);
  const date = new Date(Date.UTC(year, m, day));
  const iso = date.toISOString().slice(0, 10);
  if (day < 1 || date.getUTCMonth() !== m || iso < now.toISOString().slice(0, 10)) {
    return { text: input, handled: true, error: "Choose an available day today or later." };
  }
  return { text: iso, handled: false };
}
