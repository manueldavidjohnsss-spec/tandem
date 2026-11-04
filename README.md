# Tandem: project hub for David & Bert

A shared project-management tool with best practices built in: board, sprints with burndown,
standups, retros, an Ideas whiteboard, risks, decisions, a dashboard, and a Coach.

| Part | Where it runs |
| --- | --- |
| `web/` | Static site on **Vercel** (root directory = `web`). Every push to `main` deploys automatically. |
| `supabase/schema.sql` | Database, row-level security and realtime on **Supabase**. Safe to re-run. |
| `android/` | Thin Android wrapper. Loads the live Vercel site, so app updates arrive with every deploy. Falls back to a bundled copy offline. |

## Shipping an update
1. Change files in `web/`
2. `./scripts/bump-version.sh` (open apps then show "A new version is ready")
3. `git commit -am "…" && git push` → Vercel deploys in about a minute → web + Android users get it

## Sign-in
Email/password and **Continue with Google** (Supabase Auth). The Android app opens Google sign-in
in Chrome and returns via `ph.tandem://auth-callback`.

See `SETUP.md` for the one-time setup.
