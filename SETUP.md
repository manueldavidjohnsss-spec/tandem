# Tandem setup (short version)

The full illustrated guide is the "Tandem: Deploy Guide" doc. This is the checklist.

1. **GitHub**: create a private repo `tandem` and upload everything in this folder (not `release.jks`).
2. **Supabase**: New project (region: Singapore). Open SQL Editor, paste `supabase/schema.sql`, Run.
   Settings → API Keys → copy the **Project URL** and **Publishable key** (`sb_publishable_…`).
3. **Google Cloud**: Google Auth Platform → Branding + Audience (External, add test users) → Clients → Create → Web application.
   - Authorized JavaScript origins: `https://YOUR-SITE.vercel.app`
   - Authorized redirect URIs: `https://YOUR-REF.supabase.co/auth/v1/callback`
4. **Supabase**: Authentication → Sign In / Providers → Google → enable, paste Client ID + Secret.
5. **GitHub**: edit `web/config.js`, paste the Supabase URL + publishable key, commit.
6. **Vercel**: Add New → Project → import `tandem` → Root Directory `web` → Framework Preset **Other** → no build command → Deploy.
7. **Supabase**: Authentication → URL Configuration → Site URL = your Vercel URL; Redirect URLs add
   `https://YOUR-SITE.vercel.app/**` and `ph.tandem://auth-callback`.
8. Go back to Google Cloud and put your real Vercel URL in Authorized JavaScript origins (step 3).
9. Open the site → Continue with Google. Create a project; Bert signs in, then you add his email (team avatars → Add).
10. **Android**: install `Tandem.apk` → enter your site address once → Continue with Google.

**Updating**: edit files in `web/` on GitHub → bump `version.json` and `APP_VERSION` in `web/app.js` (or run `scripts/bump-version.sh`) → commit.
Vercel redeploys in about a minute. Web and Android users get the update automatically.

**Database changes**: re-run `supabase/schema.sql`; it's safe to run again.
