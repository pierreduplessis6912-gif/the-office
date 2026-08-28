# Calendar Integration — Architecture

Pinned before building, per direct instruction: this is a well-scoped
build, not something to start coding from a verbal description alone.
Builds on the real, verified research already done tonight — no OAuth,
Android's own native calendar provider, confirmed real, maintained
Flutter packages exist for this.

---

## Why this is being called out as a strong feature, in its own words

"This should be a very well scoped build... genuinely going to be one
of the strongest features, as this goes from the Office into a
calendar, into a shareable environment away from the app for the
first time — a snapshot of your day, plan accordingly."

Worth naming precisely why that's true, not just agreeing: every real
thing built tonight has stayed inside the Office. This is the first
capability where a job genuinely, permanently exists somewhere else —
a real calendar app, shareable, visible without ever opening the
Office at all. That's a real, different kind of value than another
list view, and it deserves the same care as anything else that
crosses that boundary.

## The real technical approach — settled, not open

**Native Android calendar provider, not Google's OAuth Calendar API.**
Confirmed directly: the existing Google OAuth in this codebase
(`openid email profile`, never captures an access/refresh token) is
genuinely a different, unrelated capability — login/access-control,
not authorization to act on a user's calendar. Reusing it was a real
dead end, not a shortcut.

The native path needs only two standard Android runtime permissions
(`READ_CALENDAR`, `WRITE_CALENDAR`) — the same familiar pattern
already used for microphone access. No client secrets, no server-side
token storage, no broader consent screen. For anyone with a real
Google account already signed into their phone (nearly everyone), the
OS itself keeps the device calendar synced with Google Calendar
automatically — so this genuinely delivers the real outcome described,
without OAuth ever entering the picture.

**Package for this first version: `flutter_native_calendar`.**
Confirmed via direct search: it specifically supports handing off to
the device's own calendar app with an event pre-filled
(`NativeCalendar.openCalendarWithEvent`) — exactly the no-permission,
person-confirms-themselves mode this first version needs. Real,
honest caveat also confirmed directly: on Android, custom reminders
aren't respected in this mode — the calendar app uses its own
defaults, not something this integration can control.

`device_calendar_plus` — confirmed current and actively maintained
(2025), explicit in its own docs about where Android/iOS genuinely
differ rather than hiding it — is the right, real choice for a later,
direct-write version, once this first one is proven. It's built for
reading and writing calendar events directly, not the hand-off mode
this first version deliberately uses instead.

## The real, first-version scope — deliberately narrow

Per the same "smallest real domino first" discipline used everywhere
else tonight:

**A real, explicit "Add to Calendar" action per job — not an ongoing
sync.** Ongoing sync means handling updates, deletions, and duplicate
prevention correctly, forever, invisibly, on someone's real calendar —
a genuinely larger, riskier problem than this first version needs to
solve. A discrete, one-time action per job, initiated by a real tap,
is honest about what it does and doesn't do, and matches Scheduler's
own newly-settled third-tap principle: this is exactly where the app
touches reality.

**Hand off to the device's own calendar app, pre-filled — not a silent
direct write, for this first version.** `flutter_native_calendar`
supports exactly this mode: opens the real, native calendar app with
the job's details already filled in; the person taps "save" themselves.
This needs no `WRITE_CALENDAR` permission at all for the first version
— only the read-side check to confirm calendar access exists. A
silent, direct write is the natural next step once this is proven, not
skipped to on a first attempt against someone's real, personal
calendar, where a bug means a wrong or duplicate entry that's
genuinely annoying to find and undo.

## What real data already exists to fill an event, verified tonight

`/debug/schedule` already returns everything the first version needs:
customer name, job description, and a real, resolved date. No new
backend work required for a first, working version — this is
retrieval of what's already there, the same "reverse engineering,"
easier-direction pattern already established for everything else
built tonight.

**Real, honest gap already known:** installer name is not currently
selected by `/debug/schedule`'s own query, despite `job_scopes` having
a real `installer_id`/`installer_name` join available (confirmed
directly earlier). Worth adding to the event description — a real,
small, low-risk backend fix, not a blocker to starting.

## What this document does not settle

- Whether a later version should move to a silent direct write, and
  what real permission-request flow/timing that deserves.
- Whether recurring or multi-day jobs need different handling — not
  yet a real, observed case.
- Whether canceling or rescheduling a job in the Office should ever
  reach back into a calendar event already created from it — a real,
  separate question that only matters once the first, one-way version
  exists and is actually used.
