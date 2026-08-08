-- Calendar providers are cloud accounts (Google/Outlook/Apple/ICS), not phone OS.
-- Rename legacy "android" → "ics" (imported calendar feeds).
ALTER TYPE "CalendarProvider" RENAME VALUE 'android' TO 'ics';
