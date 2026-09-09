# M77 — Application Distribution

Status: **IN_PROGRESS**. Development distribution acceptance; not a public release acceptance.
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
# Opt-in: uses only unique synthetic native-store entries (not a GUI test):
node scripts/verify-desktop-credentials.mjs "path/to/packaged/executable" "path/to/resources/app.asar"
# macOS only:
pnpm acceptance:desktop-dmg "desktop-artifacts/Dragons-Agent-0.1.0-mac-arm64.dmg"
```

Targets: macOS DMG/ZIP, Windows per-user NSIS, Linux AppImage/DEB. Output is ignored by Git. The archive audit rejects unexpected first-party files, local-state names and bundled development dependencies. It requires all five desktop assets and a host OS/architecture credential binding with unpacked metadata and a regular, nonempty physical sidecar. Signing can change a Mach-O sidecar's size after ASAR metadata was generated; this audit does not assert byte identity or native loadability. The executable smoke separately checks native imports; the native signature gate checks platform signature integrity. Audit success is not a malware scan or arbitrary secret-content detector.

macOS artifacts use an ad-hoc signature and are **not notarized**. Windows signing is not configured. The default Electron icon remains. These are development outputs, not public-trust or product-branding acceptance. Do not disable Gatekeeper, SmartScreen, Chromium sandboxing, or TLS to make acceptance pass.

The manual `Desktop package validation` workflow builds natively, audits the archive and exercises the real unpacked executable. It also tests the macOS DMG copy/remove path. It has read-only repository permissions and no upload/publish/signing step. Workflow definition is not evidence that its jobs passed.

On the ephemeral Ubuntu runner, the audited application is copied root-owned into `/opt/dragons-ci`. The packaged Chromium helper receives root ownership and mode `4755`; an exact-executable AppArmor profile grants `userns` for Chromium sandbox creation. This is not a general AppArmor confinement profile. No global user-namespace restriction is disabled and the application runs as the normal runner user without `--no-sandbox`. Cleanup independently attempts profile unload, profile-file removal and application removal, and reports any failure. This CI-specific setup is not Linux end-user installation acceptance.

## Verification levels

### Selected acceptance policy (2026-09-09)

The selected target is development distribution on the three existing native host platforms. M77 closure requires installer/copy removal verification and native workspace-picker and credential-store acceptance in addition to the existing archive/executable gates. Record the actual host architecture and environment with each result; a hosted CI runner is not a clean consumer machine. Preserve existing user data, never access real stored provider credentials for these checks, and do not weaken operating-system trust or Chromium sandbox controls.

Public signing/notarization, signing credential setup, public-trust clean-machine checks and publication are explicitly outside this selected acceptance scope. Their absence must remain visible as a distribution limitation, not be reported as verified or silently bypassed. Other CPU architectures remain unverified rather than implied by a platform-level result.

1. `pnpm test` includes deterministic workspace-selection, archive-policy, run-outcome and DMG cleanup failure-path tests.
2. `acceptance:desktop` tests the source-checkout Electron UI with existing deterministic fixtures.
3. `acceptance:installed` launches the actual packaged executable with an isolated temporary home/config, real remote runtime and a deterministic READ-only fixture provider. It verifies the production entry point, preload availability, Node isolation, session creation, READ execution through the runtime and a successfully settled run with the exact continuation result. Streamed text alone is not success. It closes the real page and requires a zero exit status without a termination signal; emergency process killing never produces PASS. CDP is enabled only by this test launch on loopback; no production debugging switch or renderer test API is added. Renderer discovery waits for DOM readiness, not just a CDP page URL. This is **not live provider verification**, native credential-store access, native-folder-dialog acceptance or an installer test.
4. `acceptance:desktop-dmg` mounts the image read-only, copies the app into a disposable directory (not `/Applications`), detaches it, audits and runs the copied app, then removes that copy. Even a failed attach may have mounted the image: cleanup attempts detach and never recursively deletes an uncertain mount. If detach fails, it reports the retained path for manual cleanup and fails acceptance. This is **not a fresh-machine Gatekeeper/quarantine check** or proof of system-wide installation/uninstallation.
5. Native installation/removal, local workspace picker interaction and OS-specific credential-store access require separate acceptance before M77 can close under the selected development-distribution policy. Public-trust signing/notarization and clean-consumer-machine trust checks are excluded, not passed.

## Evidence and remaining work

- macOS arm64 unpacked application and DMG/ZIP generation: locally demonstrated.
- Actual packaged executable / isolated remote fixture / READ continuation: locally demonstrated.
- Workspace-selection and archive-policy focused tests: locally demonstrated.
- Local repository gates after harness remediation: **530/530 PASS**, typecheck/build and clean-install npm package verification PASS (`pnpm release:check`). Full and production dependency audits: no known vulnerabilities.
- DMG read-only copy/audit/real-executable/graceful-close/remove acceptance: **PASS** on macOS arm64. Deep/strict ad-hoc application signature verification: **PASS**. These do not establish public-trust signing.
- Independent review identified harness false-positive and mount-cleanup issues. All three P2 findings were remediated with regression coverage; the targeted read-only re-review returned **PASS (3/3 fixed)**. This verdict covers those repairs, not cross-platform or complete M77 acceptance.
- Windows/Linux/macOS native packaging, archive audit, real executable smoke and host distribution generation: **PASS** at `b0b1628794835ef5eb1e94d2a2a1caa939c9d534`, Desktop workflow run `34326851285`. Linux required the scoped runner sandbox setup above. Windows ASAR lookups were corrected to use native path separators.
- Windows NSIS and Linux AppImage/DEB install/remove: **NOT_RUN**.
- macOS Intel or other CPU architectures: **NOT_RUN**.
- Clean-machine trust/signing/notarization: **NOT_CONFIGURED / NOT_RUN**.
- Native workspace picker and credential-store access: macOS arm64 evidence is recorded below; Windows/Linux remain **NOT_RUN**.
- M77 foundation and CI remediation commits were pushed to `main`; no publication, version bump, tag or release occurred.
- Windows job failure was reproduced with the bounded native diagnostic (64 runs, concurrency 8): `a26675b`, run `34328493226`, produced 55 passes and 9 failures, including confirmed `EPERM` from atomic rename. The external handle owner was not identified; no scanner-specific cause is claimed. macOS baseline passed 64/64. Production recovery now retries only Windows `EPERM`/`rename`, with six attempts and bounded backoff; it releases the temporary file/store lock before waiting and rechecks the original expected revision after reacquiring the lock. It never deletes the destination or relaxes permissions.
- Final code acceptance at `9b8d4ce76ab2e4289dcdf98537322fd5c15b9d41`: **538/538 tests PASS**, typecheck/build and clean-install package verification PASS (`pnpm release:check`); normal CI `34329647168` and Desktop workflow `34329650217` each passed on all three platforms. The same native Windows diagnostic passed **64/64** (run `34329647005`). These before/after results plus deterministic regression coverage close the reproduced rename-failure blocker; they do not prove that every possible Windows filesystem failure is recoverable.
- Independent review caught cancellation starvation in the first lock-held retry implementation. The final implementation releases the lock between attempts, preserves CAS, and includes a real-store cancellation regression proving no model creation, durable `cancelled`, and no claim/temp residue. Targeted re-review: **PASS, B1 resolved, no new blocker**. The native diagnostic is available through the manual `Native job stability diagnostic` workflow; output is fixed-label aggregate data, not raw errors or credentials.
- Independent review passed the ASAR, startup diagnostic and job-wait changes. The Linux policy re-review identified cleanup short-circuiting after a command failure; independent cleanup attempts now preserve failure status, with four mocked-shell success/failure scenarios passing. Native end-user trust/credential-store acceptance remains separate.

The distribution/signing policy is settled above. Do not mark M77 CLOSED until the remaining selected platform acceptance matrix has corresponding evidence; the policy decision itself does not establish installer or native-flow acceptance.

### Local native-picker checkpoint (2026-09-09)

- Host: macOS 26.6.2, arm64, existing developer account (not a clean consumer machine). Source snapshot: `4617bef`.
- Rebuilt with `pnpm desktop:pack`; packaged ASAR audit passed with 3,893 files, version `0.1.0`, target `darwin-arm64`, native credential sidecar present. Sidecar presence is not credential-store acceptance.
- Launched the actual packaged executable in local mode with a temporary workspace, an allowlisted environment, isolated HOME/config and Chromium user-data paths, and no remote-runtime variables. The production native “Choose a Dragons workspace” dialog appeared.
- Native cancellation was observed in a tracked subprocess: Escape dismissed the picker, exit code was zero, and no `.dragons` state files were created in the isolated home.
- Folder-selection acceptance remains **INCOMPLETE**: desktop automation did not reliably deliver the navigation shortcut to the native dialog. The selection attempt was terminated for cleanup and is not a passing acceptance run. No inference or native credential-store operations were attempted. This is an automation limitation, not evidence of a product defect.
- Next seam: supervised folder selection followed by a local session bound to that exact temporary directory; native credential-store acceptance with a dedicated synthetic entry; remaining Windows/Linux installation and native-flow evidence. M77 stays **IN_PROGRESS**.

### Supervised picker and native-store remediation

- The user selected the isolated temporary workspace in the actual packaged macOS application. The production UI opened; New session created exactly one isolated session with zero messages. Its persisted `workingDirectory` matched the selected directory after canonicalization. Normal application quit returned exit code zero. This completes local macOS picker selection/session-binding acceptance for the `4617bef` package, not model inference or clean-machine installation acceptance.
- A real missing-entry probe using a unique synthetic Keychain account found `AsyncEntry.getPassword()` returns `null` on this host, despite the dependency's async TypeScript declaration advertising `undefined`. Both provider and MCP loaders previously sent this result into credential parsing. The minimal remediation explicitly permits and normalizes native nullish absence; malformed string payloads still fail closed. No default provider or MCP credential account was read.
- Six deterministic regressions cover null/undefined absence in both stores and rejection of empty, JSON-null, empty-object and invalid-JSON payloads. `pnpm release:check`: **PASS**, 549/549 tests, typecheck, build and package verification; no publication or version change.
- Real source-checkout native Keychain round trips passed for both provider and MCP stores: unique synthetic service/accounts, initial absence, save, exact readback, remove and verified final absence. Only fixed-label outcomes were logged. This is **source-checkout native-store acceptance**, not execution of the store from inside the packaged Electron application. The existing package predates this remediation and must be rebuilt before claiming packaged credential-store acceptance.
- Remaining: packaged native-store execution, Windows/Linux native-flow and installation/removal evidence, and final M77 acceptance. M77 remains **IN_PROGRESS**.
- Independent read-only review of both loader changes and the regression tests: **PASS**, no blocker. Nullish normalization preserves malformed-payload rejection, backend error handling, provider fallback distinctions and MCP write verification. No material source change followed the passing release gate.

### Packaged native-store checkpoint (2026-09-09)

- Rebuilt the macOS arm64 application from `c9b8cf2` runtime sources using `pnpm desktop:pack`. Archive audit: **PASS**, 3,893 files, version `0.1.0`, native sidecar present. Both archived loaders contain the nullish-absence remediation.
- `scripts/verify-desktop-credentials.mjs` launches the packaged executable with `ELECTRON_RUN_AS_NODE=1`, loads both credential-store modules directly from the supplied `app.asar`, and resolves `@napi-rs/keyring` from that same archive. No source-checkout runtime import, production entry-point hook, provider request or default credential account is used.
- Native execution: **PASS** for provider and MCP on macOS 26.6.2 arm64, Electron `44.2.0` / Node `24.20.0`. Each store independently verified initial absence, save, exact readback, remove and final absence. All writes used fixed synthetic values with independent random UUID accounts under a dedicated acceptance service; both entries were verified deleted.
- The first isolated-HOME probe failed before writing: this host's Keychain lookup requires the logged-in user's HOME. The harness preserves HOME on macOS solely for native-store access, while its working directory and other config/temp paths remain disposable and the environment is allowlisted. It does not load application configuration, sessions or credential files. This is not complete HOME isolation.
- Evidence scope: **packaged executable in Electron Node mode plus packaged resources/native binding**, not the GUI credential route, signing/notarization, clean-machine trust or live provider inference. The harness has a 60-second deadline; abnormal exit or timeout fails acceptance and does not establish synthetic-entry cleanup.
- The same rebuilt application passed `codesign --verify --deep --strict` and `pnpm acceptance:installed` (production entry, sandbox, deterministic remote READ continuation, graceful quit). ASAR SHA-256: `ab53739480728699903b16fccae2f46ebebc887c2727804530985f94475e5fea`. This identifies the archive only, not its unpacked native sidecars.
- Harness syntax and three negative checks (missing arguments, missing executable, missing archive) passed without a false acceptance. `pnpm release:check`: **PASS**, 549/549 tests, typecheck, build and clean-install npm package verification. No runtime/dependency/version change was needed for this checkpoint.
- Independent read-only harness review: **PASS**, no confirmed blocker within the stated Electron Node-mode scope. The review checked injected synthetic accounts, actual store APIs, roundtrip/deletion and subprocess success requirements, error redaction and attempted failure cleanup. Forced-timeout cleanup remains unverified, never accepted. No material code change followed the passing gate.
- Windows/Linux native-store and picker acceptance, Windows NSIS / Linux installation-removal, and final selected-matrix acceptance remain open. M77 remains **IN_PROGRESS**.
