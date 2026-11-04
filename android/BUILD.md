# Rebuilding the APK

The APK is a thin Android WebView that loads the web app from its bundled `assets/` folder.

Easiest route (Android Studio):
1. New Project → "No Activity", package `ph.tandem`, min SDK 24.
2. Replace `AndroidManifest.xml`, `res/` and `java/ph/tandem/MainActivity.java` with the files here.
3. Copy everything in `../web/` into `app/src/main/assets/` (including your filled-in config.js).
4. Build → Generate Signed APK.

Command-line route (no Gradle), with Android build-tools 35 and platform android-35:
```
aapt2 compile --dir res -o res.zip
aapt2 link -o base.apk -I android.jar --manifest AndroidManifest.xml -A assets res.zip --java gen
javac -source 8 -target 8 -bootclasspath android.jar -d classes gen/ph/tandem/R.java src/ph/tandem/MainActivity.java
d8 --lib android.jar --output dex classes/ph/tandem/*.class
zip -j base.apk dex/classes.dex && zipalign -p 4 base.apk aligned.apk
apksigner sign --ks your.jks --out Tandem.apk aligned.apk
```
Keep using the same keystore for updates, or Android will refuse to install over the old version.

The included `release.jks` is the key Tandem.apk was signed with (alias `pmpath`, password `pmpath123`). Change the password with `keytool -storepasswd` and keep the file private.
