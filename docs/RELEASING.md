# Releasing

## Signing key

Updates are verified with a minisign key pair made for this app.

- The public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Installed apps trust only updates signed with the matching private key.
- The private key is kept at `~/.tauri/session-buddy-updater.key`, its password next to it. Keep a backup somewhere safe. If the key is lost, installed apps can never update again: a new key means everyone must reinstall by hand.
- The same key and password are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The release workflow passes them to tauri-action, which signs the updater artifacts.

## How a release reaches installed apps

1. Push a tag `vX.Y.Z` (the version comes from `src-tauri/tauri.conf.json`, keep it equal to the tag).
2. The Release workflow builds the Windows NSIS setup and the universal macOS bundle, signs them, and attaches installers, updater files (`.sig`, the macOS `.app.tar.gz`) and `latest.json` to a **draft** release.
3. Publish the draft by hand. The apps read `https://github.com/wl-lankin/session-buddy/releases/latest/download/latest.json`, and `latest` is the newest published, non-prerelease release. Until the draft is published, nobody sees the update.

`createUpdaterArtifacts` is set in `src-tauri/tauri.updater.conf.json`, which only the release workflow passes with `--config`. A normal `npm run pack` or CI build has no signing key and stays unsigned.

## First updater version

Only apps that already contain the updater can update. The first version that ships it must be installed by hand; from then on updates come through the app.
