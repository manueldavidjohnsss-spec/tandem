# Releasing a new Android app (APK)

Web changes never need a new APK: the app loads the live site. Release an APK only for
native changes (notifications, sign-in return, file saving, installer).

1. Bump `android:versionCode` (+1) and `android:versionName` in `android/AndroidManifest.xml`,
   and the same numbers in `android/src/ph/tandem/BuildConfigLite.java`.
2. Build and sign with the same key (`android/BUILD.md`).
3. Copy the signed file to `web/downloads/Tandem.apk`.
4. Update the `android` block in `web/version.json`:
   `{"version":"2.3","code":10,"url":"downloads/Tandem.apk","notes":"What changed, in one line"}`
5. Run `scripts/bump-version.sh` and commit. After Vercel deploys, every installed app shows
   "📲 Tandem 2.3 is available · Update" and installs it in-app (v2.2+) or via Chrome (older).
