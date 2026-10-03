# How Traveler uses calendar data

Connect Calendar reads Google Calendar with the `calendar.readonly` scope. Inbox access is not requested.

We keep derived trip facts only: destination city, origin city when we can tell, departure and arrival instants in UTC, and the IANA timezone on the event. We do not store the raw calendar event, its description, or a mailbox.

A detected flight is a proposal until you opt in. Disconnect stops sync and drops proposals you did not opt into. Trips you opted into stay, including if you disconnect later. An erasure request deletes the connection and those derived trips unless a Shop & Deliver claim is already in progress.

Calendar data isn’t sold, used for ads, or used to train general-purpose AI models.
