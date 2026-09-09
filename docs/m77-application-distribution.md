# M77 — Application Distribution

Status: **IN_PROGRESS**. Initial local packaging foundation; not a release acceptance.
Package version remains `dragons-agent@0.1.0`.

## Scope and trust boundary

- Build native desktop application targets from the existing Electron shell and runtime.
- Keep the CLI/runtime npm entry point and production dependencies unchanged.
- Select a packaged local workspace through a trusted native main-process dialog. Never use the launcher's arbitrary current directory, an application resource directory, or renderer IPC to choose it. Cancel exits before runtime creation. Source-checkout and remote launches preserve their existing behavior.
- Preserve renderer sandbox, context isolation, navigation/network denial and the authoritative `runAgent()` READ/WRITE/EXECUTE boundary.
- Include only application assets, compiled runtime modules, license/metadata and production dependencies. Exclude source, tests, live acceptance utilities and local state. Native credential bindings are unpacked from ASAR; no credentials are bundled or created for acceptance.
- No auto-update, npm publication, version bump, tag, GitHub Release, signing credential setup, or public distribution.

## Local commands

Requires the repository's Node.js and pnpm versions, and a native build host for each platform/CPU. Do not equate cross-compilation with native acceptance.

```sh
pnpm install --frozen-lockfile
pnpm desktop:pack  # unpacked application in desktop-artifacts/
pnpm desktop:dist  # host-platform installers/archives, --publish never
pnpm verify:desktop-package "path/to/resources/app.asar"
pnpm acceptance:installed "path/to/packaged/executable"
# macOS only:
pnpm acceptance:desktop-dmg "desktop-artifacts/Dragons-Agent-0.1.0-mac-arm64.dmg"
```

Targets: macOS DMG/ZIP, Windows per-user NSIS, Linux AppImage/DEB. Output is ignored by Git. The archive audit rejects unexpected first-party files, local-state names and bundled development dependencies. It requires all five desktop assets and a host OS/architecture credential binding with unpacked metadata and a regular, nonempty physical sidecar. Signing can change a Mach-O sidecar's size after ASAR metadata was generated; this audit does not assert byte identity or native loadability. The executable smoke separately checks native imports; the native signature gate checks platform signature integrity. Audit success is not a malware scan or arbitrary secret-content detector.

macOS artifacts use an ad-hoc signature and are **not notarized**. Windows signing is not configured. The default Electron icon remains. These are development outputs, not public-trust or product-branding acceptance. Do not disable Gatekeeper, SmartScreen, Chromium sandboxing, or TLS to make acceptance pass.

The manual `Desktop package validation` workflow builds natively, audits the archive and exercises the real unpacked executable. It also tests the macOS DMG copy/remove path. It has read-only repository permissions and no upload/publish/signing step. Workflow definition is not evidence that its jobs passed.

## Verification levels

1. `pnpm test` includes deterministic workspace-selection, archive-policy, run-outcome and DMG cleanup failure-path tests.
2. `acceptance:desktop` tests the source-checkout Electron UI with existing deterministic fixtures.
3. `acceptance:installed` launches the actual packaged executable with an isolated temporary home/config, real remote runtime and a deterministic READ-only fixture provider. It verifies the production entry point, preload availability, Node isolation, session creation, READ execution through the runtime and a successfully settled run with the exact continuation result. Streamed text alone is not success. It closes the real page and requires a zero exit status without a termination signal; emergency process killing never produces PASS. CDP is enabled only by this test launch on loopback; no production debugging switch or renderer test API is added. Renderer discovery waits for DOM readiness, not just a CDP page URL. This is **not live provider verification**, native credential-store access, native-folder-dialog acceptance or an installer test.
4. `acceptance:desktop-dmg` mounts the image read-only, copies the app into a disposable directory (not `/Applications`), detaches it, audits and runs the copied app, then removes that copy. Even a failed attach may have mounted the image: cleanup attempts detach and never recursively deletes an uncertain mount. If detach fails, it reports the retained path for manual cleanup and fails acceptance. This is **not a fresh-machine Gatekeeper/quarantine check** or proof of system-wide installation/uninstallation.
5. Public-trust signing/notarization, native OS clean-user installation/removal, local workspace picker interaction and OS-specific credential-store access require separate acceptance before M77 can close.

## Evidence and remaining work

- macOS arm64 unpacked application and DMG/ZIP generation: locally demonstrated.
- Actual packaged executable / isolated remote fixture / READ continuation: locally demonstrated.
- Workspace-selection and archive-policy focused tests: locally demonstrated.
- Local repository gates after harness remediation: **530/530 PASS**, typecheck/build and clean-install npm package verification PASS (`pnpm release:check`). Full and production dependency audits: no known vulnerabilities.
- DMG read-only copy/audit/real-executable/graceful-close/remove acceptance: **PASS** on macOS arm64. Deep/strict ad-hoc application signature verification: **PASS**. These do not establish public-trust signing.
- Independent review identified harness false-positive and mount-cleanup issues. All three P2 findings were remediated with regression coverage; the targeted read-only re-review returned **PASS (3/3 fixed)**. This verdict covers those repairs, not cross-platform or complete M77 acceptance.
- Windows/Linux native packaging and smoke: **NOT_RUN**.
- Windows NSIS and Linux AppImage/DEB install/remove: **NOT_RUN**.
- macOS Intel or other CPU architectures: **NOT_RUN**.
- Clean-machine trust/signing/notarization: **NOT_CONFIGURED / NOT_RUN**.
- Native workspace picker end-to-end and native credential-store access: **NOT_RUN**.
- No M77 commit, push, remote CI dispatch, publication or release is implied by local acceptance.

Do not mark M77 CLOSED until the selected platform acceptance matrix and distribution/signing policy are explicitly settled and the corresponding evidence is available.
