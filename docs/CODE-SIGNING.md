# Code signing (Windows)

The Windows installer is not signed yet, so Windows SmartScreen warns on the first manual install ("Windows protected your PC": More info > Run anyway). Free signing for open source is available from the [SignPath Foundation](https://signpath.org/terms.html). This file is the plan and the checklist.

## State

- The README has the "Code signing policy" section SignPath requires (heading, the attribution sentence, roles, privacy).
- The application to the SignPath Foundation is made by the maintainer (it needs their identity and GitHub two-factor).
- The release workflow does NOT sign yet: the SignPath project, policy and token do not exist until the application is approved.

## When SignPath approves

1. In SignPath: note the organization id, the project slug and the signing policy slug; create an API token for CI; add them as repository secrets (`SIGNPATH_API_TOKEN`) and variables (`SIGNPATH_ORGANIZATION_ID`, project and policy slugs).
2. Release workflow, Windows job, in this order:
   1. Build the installer unsigned (no updater artifacts yet).
   2. Upload it as a workflow artifact and submit it to SignPath with `signpath/github-action-submit-signing-request` (origin verification is required for the foundation certificate: the artifact must come from this repository's workflow run). The maintainer approves the request in SignPath (every release needs one manual approval).
   3. Download the signed installer.
   4. Create the updater signature (minisign, `tauri signer sign`) over the SIGNED installer. The signature must be made after Authenticode signing: signing changes the bytes, a signature made before would no longer match.
   5. Build `latest.json` for the signed installer (the same shape tauri-action writes today) and upload installer, `.sig` and `latest.json` to the draft release.
3. Installer metadata: the SignPath policy checks product name and version in the file's metadata; make sure the NSIS installer carries them (Tauri takes them from `tauri.conf.json`).
4. Keep the macOS job as it is.

## Notes

- SmartScreen reputation: a signed installer can still warn for a while until the certificate has built up reputation; the signature makes the publisher name show instead of "Unknown publisher".
- An update that the app downloads itself carries no "downloaded from the internet" mark, so SmartScreen does not warn there, signed or not.
- Alternative route, not taken: Microsoft Store with an MSIX. It costs nothing now, but a packaged app's `%LOCALAPPDATA%` writes are redirected into the package (our relay and config would have to move out of AppData), it cannot use our own updater, it needs Microsoft's certification, and a managed PC may block the Store.
