# Code signing (Windows)

The Windows app, the relay and the installer are Authenticode-signed with [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing). The certificate names "Wolfgang Linz" as publisher; Microsoft validated the identity.

## Azure

- Subscription "Azure subscription 1", resource group `code-signing`, account `wolfganglinz-signing` (North Europe, endpoint `https://neu.codesigning.azure.net`, Basic plan).
- Certificate profile `wolfganglinz-public` (Public Trust, street address and postal code left out). Its certificates live only a few days and are renewed by Azure; the timestamp keeps a signature valid after that.
- App registration `github-code-signing` with the role "Artifact Signing Certificate Profile Signer" on the account only. It has no secret: a federated credential trusts GitHub OIDC tokens for `repo:wl-lankin/session-buddy:environment:release`.

## GitHub

- Environment `release`; the release and the check workflow run their Windows job in it.
- Repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (ids, not secrets).
- `.github/actions/windows-signing` downloads Microsoft's signing client (pinned version and SHA-256), writes its `metadata.json` and a Tauri config with `bundle.windows.signCommand`. `sign.ps1` fetches a fresh OIDC token for every file and runs `signtool` with the client's dlib.
- The release workflow signs the relay right after building it, then passes the signing config to `tauri build`. Tauri signs the app and the installer during the build, so the updater `.sig` files are made over the signed installer.
- `windows-signing-check.yml` builds and signs without releasing and checks the signatures. It runs on pull requests that touch the signing setup, or by hand.

## Notes

- SmartScreen reputation: a signed installer can still warn for a while until the certificate has built up reputation; the publisher name shows instead of "Unknown publisher".
- An update that the app downloads itself carries no "downloaded from the internet" mark, so SmartScreen does not warn there, signed or not.
- macOS signing and notarization need the Apple Developer Program and are not set up yet.
