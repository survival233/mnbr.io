/**
 * Normalize a calendar "deliver by" day to the last millisecond of that local
 * day so same-day departures remain eligible under inclusive deadline matching.
 */
export function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
