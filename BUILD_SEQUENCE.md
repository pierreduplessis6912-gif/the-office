# The Office — App Build Sequence

Everything still needed to take the app from where it stands tonight
to a genuinely complete, native-ready build. Aesthetics deliberately
set aside — this is the real, functional scope. Split honestly by
where each item can actually be verified: the dev URL (web preview)
proves anything pure HTTP/UI; only a real, native Android build proves
anything touching device permissions, hardware, or the OS itself.

---

## A. Android-native-only — cannot be verified any other way

1. **Add `CAMERA` permission to the Codemagic patch script.** Real,
   concrete gap found tonight: `codemagic.yaml`'s bootstrap step
   already patches `INTERNET` and `RECORD_AUDIO` into the generated
   manifest, but not `CAMERA` — added tonight's `image_picker` with
   `ImageSource.camera`, which needs it. Without this, the camera
   button would very likely fail on a real device despite working
   fine in the web preview, where the browser owns its own,
   completely different permission model.
2. **Confirm whether `file_picker` needs a storage/media permission
   patched in too.** Genuinely uncertain rather than assumed — modern
   Android's system file picker often doesn't require one the way
   camera does, but this can only be settled by an actual native
   build, not reasoning about it.
3. **Trigger a real, fresh Codemagic build.** The only installed APK
   that exists predates the entire chat-UI redesign — a genuinely
   different, much older app. Nothing built since (ledger-line
   design, embers, confirm/reject, camera/document upload) has ever
   run natively.
4. **Verify the real permission-request dialogs** Android actually
   shows the user for microphone and camera, and that denial is
   handled gracefully rather than crashing or silently failing.
5. **Verify real camera-app launching and file-picker behavior**
   under Android's actual scoped-storage rules — genuinely different
   from a browser's file input.
6. **Google OAuth login, adapted for native.** The backend already
   has a real, complete, properly-built OAuth flow
   (`/auth/google/login`, `/auth/google/callback`, `/auth/me`,
   `/auth/logout`) — nothing new to build there. But it's a
   redirect-based web flow (a 302 to Google, then a callback), which
   a native app can't just "follow" the way a browser tab does. Needs
   an in-app-browser approach (e.g. `flutter_web_auth_2`) to capture
   the callback properly — a real, separate integration task from the
   backend work, which is already done.

## B. Fully buildable and verifiable in the dev URL

1. **Wire the "Reports & Documents" drawer item** to the real,
   already-proven P&L and Aged Debtors PDF links.
2. **Wire the "People" drawer item** to a real list — `/debug/characters`
   already exists; whether customers belong in the same list (since
   Leads were assigned to live here) is a real, small design choice
   still open.
3. **Wire the "History" drawer item** to `/debug/captures`, which
   already exists and returns the real input side (`raw_text`) per
   customer/character. Whether it (or a companion route) also carries
   the paired output side, which the agreed input/output ledger
   design needs, is a real, open question worth checking before
   building this — not yet confirmed either way.
4. **Build real login UI** — a "Sign in with Google" entry point in
   the app, calling `/auth/google/login` and checking `/auth/me` for
   signed-in state. On web this is straightforward (the browser
   follows the redirect naturally); the native wrapper is Category A
   above.
5. **Wire the three-dot menu's "Account" item** to real, signed-in
   state from `/auth/me` — the "who am I" indicator named as a real,
   open gap in `UI_MAP.md`.
6. **Wire "Settings"** to Corporate Stationary (the real, already-built
   logo capture/serve endpoints).
7. **Re-verify confirm/reject and the generated-PDF-link display**
   against a real, live guard()'d action (a quotation, a payment) in
   the rebuilt shell specifically — the code carried over from the
   original build, but hasn't been re-proven live since the rebuild.
8. **Build real, specific ember-sheet detail views** beyond the
   current generic text cards — e.g. Suppliers showing today's
   expenses and Aged Creditors as genuinely separate, labeled
   sections rather than one flat list; Scheduler showing real project
   grouping rather than a flat job list.
9. **"Help & tutorials"** — likely simple, static content; lowest
   priority of this whole list.

---

Nothing here is aesthetic. Every item is either a real, missing wire
between existing frontend and existing, already-proven backend
capability, or a real, concrete native-permission gap found by
checking the actual build configuration rather than assuming it was
handled.
