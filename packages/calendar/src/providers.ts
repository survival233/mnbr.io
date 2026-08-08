/**
 * Where the traveler's flight events live.
 *
 * - google / outlook — cloud accounts (any device via OAuth)
 * - apple            — phone/local Calendar.app / iCal (and iCloud if on-device)
 * - ics              — imported .ics feed / file
 *
 * Flights added only to the phone calendar never appear in Google/Outlook —
 * those require the device path (`trips.syncDeviceCalendar`).
 */
export const CALENDAR_PROVIDERS = ["google", "outlook", "apple", "ics"] as const;
export type CalendarProviderName = (typeof CALENDAR_PROVIDERS)[number];

/** Cloud OAuth providers — server can pull events with an access token. */
export const CLOUD_CALENDAR_PROVIDERS = ["google", "outlook"] as const;
export type CloudCalendarProvider = (typeof CLOUD_CALENDAR_PROVIDERS)[number];

/** On-device / local calendars — client must read and post events. */
export const DEVICE_CALENDAR_PROVIDERS = ["apple", "ics"] as const;
export type DeviceCalendarProvider = (typeof DEVICE_CALENDAR_PROVIDERS)[number];

export function isCalendarProvider(v: string): v is CalendarProviderName {
  return (CALENDAR_PROVIDERS as readonly string[]).includes(v);
}
