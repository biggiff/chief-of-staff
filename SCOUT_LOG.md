# Scout Log

One place for bugs and feature requests. Newest first.

## 2026-06-07

| # | Type | Item | Status |
|---|------|------|--------|
| 1a | Bug | Duplicate task creation — Scout created a workout task 6× without confirmation. | ✅ fixed — `create_task` now checks for similar open tasks and asks before making a duplicate (`force=true` to override). |
| 1b | Bug | `get_todoist_tasks` returned 0 despite tasks in Inbox. | ✅ fixed — root cause was a silent truncation to the first 40 tasks; recently-added Inbox tasks fell off. Now returns all active (up to 300). |
| 2 | UI | Chat box too low — activates iOS home-bar / Siri gesture. | ✅ fixed — added safe-area inset (`env(safe-area-inset-bottom)`) + `viewport-fit=cover` so the input clears the home bar. |
| 3 | Feature | Photo uploads in chat for Scout to review. | ✅ done — attach button, client-side resize, image sent to Scout (vision), shown in the bubble, persisted in history. |
| 4 | Bug (mobile) | Editing an idea: couldn't scroll to Save; window too small. | ✅ fixed — backstage `main` was `overflow-hidden` after the mobile layout change; now scrolls. |
| 5 | UI | Chat should open at the most recent message, not the top. | ✅ fixed — chat jumps to the latest message on open. |
| 6 | Feature | Gmail — read all folders, create drafts, send (with permission). | ✅ built; needs a one-time Google re-consent to grant Gmail scopes (user step). Sending always asks first. |
