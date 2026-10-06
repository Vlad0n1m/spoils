# SPOILS Android app, WebView shell (alternative to the TWA)

`twa/` (Bubblewrap TWA) is the primary Android build. Use this WebView shell when the **wallet must work
inside the APK**. Solana Mobile reports that Chrome's Local Network Access restrictions break Mobile Wallet
Adapter in TWA wrappers such as Bubblewrap APKs. The shell is a native WebView that sends `solana-wallet:`
intents straight to the installed wallet app (Phantom, Solflare, Seed Vault). It needs no Digital Asset Links.

Sources (checked 2026-10-04): https://docs.solanamobile.com/recipes/general/publishing-a-web-app.md,
https://docs.solanamobile.com/cli/webshell.md, CLI `solana-mobile@0.5.0`.

## What is versioned here

| File | Purpose |
| - | - |
| `web-manifest.json` | Seeds `init`: name SPOILS, colors `#08070B`, the launcher icon from `../apps/web/public/icon-512.png` (read locally, no fetch), start URL `https://SPOILS_DOMAIN/play` (overridden by `--url`). |
| `patch-android.sh` | Run after every `init`: locks landscape (`sensorLandscape`), turns off pull-to-refresh (otherwise any downward swipe reloads the page mid-raid) and hides the system bars, adds the `VIBRATE` permission (haptics). Idempotent. |
| `.gitignore` | The generated `android/` project and any keystore stay out of git. |

## Web side

- `@solana-mobile/wallet-standard-mobile` must be **≥ 0.5.1** so it recognises the shell (it looks for
  `Solana Mobile Web Shell` in the user agent). `apps/web` already uses **0.6.0**, so no change is needed.
- Only the configured host is opened inside the app. Links to other hosts open in the system browser. The game
  server WebSocket (`wss://game.<domain>`) is not a navigation, so it works.

## Requirements

Node with npx, **JDK 17+** and the **Android SDK** (`ANDROID_HOME`). The CLI installs neither of them, so a missing
toolchain shows up as a Gradle error. `npx solana-mobile@0.5.0 doctor` checks the setup. The first build also
downloads Gradle and the Android dependencies (several hundred MB).

## Build

```bash
cd webshell
DOMAIN=play.example.com                      # the real web domain (SPOILS_DOMAIN)
export SOLANA_MOBILE_KEYSTORE_PASSWORD='…'   # from the password manager, never committed
export SOLANA_MOBILE_KEY_PASSWORD='…'        # same as the store password unless the key has its own

# 1. Generate the Android project into webshell/android (git-ignored). Re-run with --force to regenerate.
npx solana-mobile@0.5.0 webshell init android \
  --manifest web-manifest.json \
  --url "https://$DOMAIN/play" \
  --application-id app.spoils.twa \
  --app-name SPOILS \
  --version-code 2 --version-name 0.2.0 \
  --keystore-path ~/keys/spoils-upload.jks --keystore-alias spoils

# 2. Game tweaks (landscape, no pull-to-refresh, immersive).
./patch-android.sh android

# 3. Signed release APK -> android/app/build/outputs/apk/release/app-release.apk
npx solana-mobile@0.5.0 webshell build android

# Check the signature and install on a connected device (adb)
apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
npx solana-mobile@0.5.0 device install android/app/build/outputs/apk/release/app-release.apk
```

## Debug build (no release key)

For testing and hackathon demos, a debug-signed APK needs no release keystore and no passwords. `init` always
asks for a keystore path, so point it at the standard Android debug keystore (`~/.android/debug.keystore`, alias
`androiddebugkey`; Android Studio and Gradle create it on first debug build, or create it with
`keytool -genkeypair -keystore ~/.android/debug.keystore -storepass android -keypass android -alias androiddebugkey
-keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`). An existing keystore is
reused without a password prompt. Then build with Gradle directly instead of `webshell build`:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
cd webshell
npx solana-mobile@0.5.0 webshell init android --manifest web-manifest.json --url https://spoils.gg/play \
  --application-id app.spoils.twa --app-name SPOILS --version-code 2 --version-name 0.2.0 \
  --keystore-path ~/.android/debug.keystore --keystore-alias androiddebugkey
./patch-android.sh android
(cd android && ./gradlew assembleDebug)   # -> android/app/build/outputs/apk/debug/app-debug.apk
mkdir -p ../dist-mobile && cp android/app/build/outputs/apk/debug/app-debug.apk ../dist-mobile/spoils-0.2.0.apk
```

`dist-mobile/` is git-ignored. A debug APK is `debuggable` and signed with a key every Android developer has, so
it is not for the dApp Store and cannot be updated by a release-signed APK with the same id (uninstall first).

Notes:

- **Same id and key as the TWA.** `app.spoils.twa` and `~/keys/spoils-upload.jks` (alias `spoils`) are the
  TWA's values, so the shell APK installs as an **update** over the TWA and keeps the same dApp Store listing.
  Use a `--version-code` higher than the last TWA release. For a side-by-side test install, pass
  `--application-id app.spoils.webshell` instead. `init` creates the keystore only if the path does not exist.
  Every later update must be signed with the same key.
- `init` saves its settings to `android/twa-manifest.json`, with the absolute keystore path and no passwords.
  The CLI writes the PNG icon as an adaptive-icon foreground with an 18dp inset, so the 512 px icon fits the
  safe zone.
- `pnpm dlx solana-mobile@0.5.0 …` works the same as `npx`. The version is pinned so that `patch-android.sh`
  matches the template. After you upgrade the CLI, re-run the patch script. It exits with an error if a
  patch no longer applies.
- Publishing: submit the signed APK through the regular Solana dApp Store flow.
