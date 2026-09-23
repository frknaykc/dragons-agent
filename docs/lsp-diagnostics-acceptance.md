# 2.1 LSP Diagnostics — uygulama ve kabul kaydı

Durum: **2.1 scoped geliştirme kabulü tamamlandı (2026-09-23).** Bağımsız kaynak incelemesi PASS; nihai `pnpm release:check`: **1201 başarılı, 2 atlanan, 0 hata**, typecheck/build/package başarılı. Kullanıcının devam onayıyla yapılan gerçek sunucu kabulünde Microsoft `@typescript/native-preview@7.0.0-dev.20260707.2` FULL pull üzerinden TS2322 ve düzeltme sonrası boş tanıyı production `runAgent()` model devamına iletti. Ana ajan `dragons-real-lsp-jOIe2e/evidence.json` içindeki wire yanıtlarını, onayları ve continuation çıktılarını doğruladı. Bu pinli macOS arm64 preview kabulüdür; varsayılan/stable sunucu seçimi değildir. TLS 5.0.0 unversioned push uyumsuzluğu sürer. Native GUI/PTY, kullanıcı tarafından elle UAT ve kurulu diğer platformların kabulü iddia edilmez. M78 üretim kapıları ve 2.2+ kapsamı değişmedi.

## Akış ve yetki

- Aktif profil `config.json`: tek açık mutlak `command`, en çok 16 `args`, `languageId`, en çok 16 `extensions`, 100–10000ms timeout (varsayılan 3000). Varsayılan kapalı; keşif/auto-install/PATH/shell veya inherited provider credential environment yok.
- Başarılı built-in write/edit/patch sonrasında en çok dört eşleşen belge için ayrı `EXECUTE lsp_diagnostics_start` onayı. WRITE ve önceki session onayı başlangıç yetkisi vermez. Her inceleme yeni process; `allow_session` sonraki başlangıcı yetkilendirmez. Ret başarılı yazmayı geri almaz.
- `runAgent()` tek yürütme yetkisidir. Başarısız/eşleşmeyen yazma, shell/MCP, rollback, child ve persistent background job bu akışı başlatmaz.
- CLI gerçek TTY renderer ve plain/interactive akış ile Desktop gerçek renderer artık **komut + sıralı argüman dizisi + belge** kapsamını eksiksiz/JSON-quoted gösterir. Aynı interpreter ile script A/B farklı görünür. Runtime yalnız allowlisted `lspApproval` DTO taşır; arbitrary raw tool arguments istemciye eklenmez. Desktop bridge DTO'yu doğrular; renderer `textContent` kullanır, içerik kaydırılabilir ve sarılır; kesilmez.
- Onay kapsamı: serialized UTF-8 JSON en çok 4096 bayt, command/arg başına 2048 karakter, belge 512 karakter, 16 arg. Tanınan credential değer/flag, control/format karakter, ek alan veya aşım güvenli gösterime izin vermiyorsa **onay ve startup öncesinde ret**; gizlenmiş/kesilmiş kimlikle onay alınmaz. Lexical secret detection eksiksiz değildir; config'e credential konmamalıdır.
- İsteğe bağlı full-screen TUI kapsamı tamamen gösteremediği için LSP startup'ını reddeder ve CLI/Desktop'a yönlendirir. Diğer TUI onayları korunur; yeni TUI parity iddiası yoktur.

## Protokol ve sınırlar

Gerçek Content-Length JSON-RPC initialize → initialized → didOpen → full document/diagnostic veya exact URI/version=1 publishDiagnostics. Unversioned/eski/başka URI push kabul edilmez. Model continuation ve CLI/Runtime tool output bounded/redacted line/column/severity/message taşır; gerçek compiler doğruluğu iddiası yoktur. Server request (-32601) reddedilir; edit/executeCommand/configuration/watchers/read-file uygulanmaz.

Belge 128KiB, frame 256KiB, başlık 8KiB, toplam stdout+stderr 2MiB, 256 mesaj. Parser yalnız geçerli frame için sabit sınırlı buffer tutar; komşu frame'ler ayrı, 64KiB veya tek birleşik chunk geldiğinde aynı stream aynı sonucu verir. En çok 20 tanı, mesaj 512 karakter, belge raporu 8192, toplam 16384 karakter; runtime kendi event sınırlarını korur. Stderr ve tanı dışı metadata rapora alınmaz. İptal, eksik server, exit, deadline/protokol/kaynak hataları temiz rapor değildir.

Shutdown yanıtı ardından exit; 200ms cleanup deadline sonunda kill. POSIX aynı process-group temizliği best effort; detached/Windows descendant garantisi yok. Symlink/hardlink, workspace escape, tanınan credential yolları, binary/non-UTF-8/oversized belge dışlanır. Bu **OS sandbox değildir**: onaylı server arbitrary local code olup proje plug-in/config okuyabilir, dosya yazabilir ve ağa çıkabilir. Mutable ancestors/out-of-band writers için atomik garanti yok. Rapor açılan post-write snapshot'a aittir.

## Yeni blocker regresyonları ve kanıt

### Kümülatif bütçe / chunk bağımsızlığı takip onarımı

- stdout bütçesi artık chunk tesliminde değil başlık/gövde baytları tüketildikçe sayılır; stderr aynı 2MiB bütçesini kullanır. Tam sınırda tamamlanan tanı kabul edilir. Sonraki trafik kabul edilmiş raporu değiştirmez; aşım parser'ı durdurur ve process kill başlatır, mevcut en çok 200ms cleanup korunur. Sabit frame buffer ve 256 mesaj sınırı kaldırılmadı.
- `tests/core/lsp-chunking.test.mjs`: 98 bayt initialize + sekiz toplam 2095968 bayt log + 162 bayt tanı + 4094 bayt son log; ayrı frame, initialize sonrası 64KiB, tek chunk ve bütçe sınırından bölünmüş akışlar. Sınırdan bir bayt önce/tam sınırda tanı, tanının header/body içinde aşım, stderr birleşik bütçe ve normal shutdown/exit dahil 7 senaryo × 4 yerleşim. Tanıdan önce aşım her yerleşimde aynı output-limit hatasıdır; cleanup her koşuda doğrulanır.
- İlk behavioral RED: birleşik chunk output-limit döndürürken ayrı frame EXPECTED döndürdü. Odaklı son koşu **33 passed, 0 failed, 0 skipped** (chunking, diagnostics, approval, presentation). Önceki 129-test approval kanıtı ayrı ve korunmuştur.
- Son materyal değişiklikten sonra `pnpm release:check` **bir kez**, exit 0: **1203 test, 1201 passed, 0 failed, 2 skipped**; typecheck/build/package başarılı, `PACKAGE_ACCEPTANCE_OK dragons-agent-0.1.0.tgz` ve `RELEASE_CHECK_OK`. Bu satır yalnız sonuç kaydıdır; gate sonrası kod/test değişmedi.
- Kanıtlar: `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-budget-red.log`, `lsp-budget-focused.log`, `lsp-budget-release-check.log` (üçü aynı scratch dizininde). Canonical gate aşağıdaki teslim kaydıyla raporlanır. Bu takip onarımı canlı server/provider veya milestone kapanışı değildir.

- Reviewer probe önce okundu. `tests/core/lsp-chunking.test.mjs` deterministic injected stdio ile aynı near-256KiB + komşu frame stream'ini ayrı/64KiB/tek chunk geçirir. Onarım öncesi ayrı stream başarılı, birleşik stream output-limit hatası: **behavioral RED**.
- `tests/core/lsp-approval.test.ts`: gerçek `TerminalRenderer` TTY dalı, A/B script ayrımı; hostile controls, credential flag/value, oversized/multibyte scope, extra-field ve redaction retleri. TTY script görünürlüğü onarım öncesi **RED**.
- `tests/integration/lsp-presentation.test.ts`: plain/interactive CLI; gerçek runtime → Desktop bridge → gerçek renderer JS (deterministik DOM/VM) zincirinde A/B script ve belge; unsafe scope'un event öncesi reddi; tek kullanımlı onay ve rapor. Runtime DTO eksikliği onarım öncesi **RED**.
- `tests/desktop/desktop-renderer.test.ts`: gerçek renderer script/beleğe erişim, eksik/oversized/control scope için onay gizleme + deny; A/B görünürlüğü onarım öncesi **RED**. `tests/desktop/desktop-bridge.test.ts`: hostile DTO'nun renderer'a ulaşmadan reddi.
- `tests/core/lsp-diagnostics.test.ts` ve stdio fixture: önceki config, write/edit/patch, path, iptal, full pull/versioned push, kaynak sınırı ve yaşam döngüsü testleri korunur; oversized header ve unsafe scope için authorizer/startup no-call regresyonları eklendi.
- `tests/tui/tui-controller.test.ts`: kapsam gösteremeyen optional TUI'nin blind approval yerine deny etmesi; mevcut onay regresyonları korunur.
- Son odaklı koşu: **129 passed, 0 failed, 0 skipped**. Komut: `pnpm build:tests && node --test tests/core/lsp-chunking.test.mjs .test-build/core/lsp-approval.test.js .test-build/core/lsp-diagnostics.test.js .test-build/integration/lsp-presentation.test.js .test-build/desktop/desktop-renderer.test.js .test-build/desktop/desktop-bridge.test.js .test-build/tui/tui-controller.test.js`.
- Önceki **1190 passed / 2 skipped** gate bu onarımları kapsamıyor. Son materyal değişiklikten sonra `pnpm release:check` **bir kez** çalıştırılır; yeni sonucun tam kaydı aşağıdaki ayrı blocker logunda ve teslim raporundadır. Eski gate blocker kabulü sayılmaz.

Aktif profil scratch kanıtları:

- `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-blockers-red.log`
- `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-desktop-red.log`
- `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-blockers-focused.log`
- `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-blockers-release-check.log`

Önceki fixture tesliminde canlı provider/language-server, private repo verisi, installed-platform/Electron görsel kabulü yoktur. Renderer testleri gerçek JS'yi deterministic DOM ile çalıştırır, native pencereyi değil. Yeni dependency, credential işlemi, stage/commit/push veya release yapılmadı. Başlangıç dirty/untracked değişiklikleri korunmuştur. Bu kayıt milestone'u kapatmaz.

## Gerçek TypeScript sunucusu — 2026-09-23: BLOCKED

Opt-in harness: `tests/acceptance/lsp-real-server.mjs`. Normal test keşfine girmez, bağımlılık kurmaz; mevcut production `dist/agent.js` → `runAgent()` ve built-in `write_file`/`edit_file` kullanır. Deterministik model, ayrı WRITE/EXECUTE authorizer ve gerçek subprocess stdout gözlemcisi vardır; observer protokolü değiştirmez, yanıt üretmez. Her EXECUTE isteğinde mutlak Node kimliği, sıralı `[cli.mjs, --stdio]` argümanları ve `a.ts` belge kapsamı birebir doğrulanır.

Ön kontrol: PATH/global/repo içinde typescript-language-server bulunmadı; repo TypeScript 5.9.3 zaten kurulu. Public npm registry'den **typescript-language-server 5.0.0 + typescript 5.9.3**, yalnız scratch prefix'e `--ignore-scripts --save-exact` ile kuruldu. Node **v22.22.3**, pnpm **11.17.0**. Repo/global dependency, kullanıcı config'i ve credential değişmedi.

Tekrarlama (repo kökünde; harness öncesinde mevcut kaynak için `pnpm build` gerekir):

```sh
SCRATCH=/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch
npm install --prefix "$SCRATCH/lsp-real-acceptance-deps" --ignore-scripts --no-audit --no-fund --save-exact --registry=https://registry.npmjs.org typescript-language-server@5.0.0 typescript@5.9.3
node --check tests/acceptance/lsp-real-server.mjs
node tests/acceptance/lsp-real-server.mjs "$SCRATCH" "$SCRATCH/lsp-real-acceptance-deps"
git diff --check
```

Bu koşuda önceki doğrulanmış release build kullanıldı; production değişmedi ve full release gate tekrarlanmadı. Harness exit **2**, gerçek kabul başarısızlığını açıkça bildirir; syntax/diff kontrolü başarılı.

- **Varsayılan kapalı:** iki WRITE, sıfır EXECUTE/sunucu spawn; LSP raporu yok.
- **EXECUTE ret:** iki WRITE + iki ayrı EXECUTE ret; sıfır spawn; dosya düzeltmesi kalır, model/event `EXECUTE denied` alır.
- **İzinli:** iki WRITE + iki ayrı EXECUTE onayı, iki gerçek server process. `export const count: number = "wrong";` için wire'da **TS2322** (`Type 'string' is not assignable to type 'number'.`, 1:14) görüldü. `edit_file` ile `42` düzeltmesi sonrası yeni process aynı URI için boş diagnostics yayımladı.
- **Runtime sonucu:** her iki snapshot için `LSP: timeout; diagnostics unavailable.`; hata/temiz rapor model devamına ulaşmadı. Wire'da hata ve düzeltme görülmesi runtime kabulü değildir. İki doğrudan server PID'sinin çıktığı ayrıca doğrulandı; tüm platform descendant garantisi iddia edilmez.

**Somut neden:** initialize yanıtında `diagnosticProvider` yok; her iki `publishDiagnostics.params` içinde `version` yok. TLS 5.0.0 dağıtımındaki `lib/cli.mjs:19707–19715`, `publishDiagnostics()` bildirimini yalnız `{uri, diagnostics}` ile kurar. Production `src/lsp-diagnostics.ts:123` ise exact URI **ve version=1** şartını korur; bu yüzden mesajları bilinçli olarak reddeder. Timeout artırmak çözmez. TS semantic hata gerçekten hesaplandı; sorun process başlatma/TypeScript bulunamaması değil, freshness sözleşmesi uyumsuzluğudur.

**Sınırlı onarım seçeneği (bu adımda uygulanmadı):** versioned push/full pull sunan gerçek bir server ile aynı acceptance'ı çalıştırmak veya TLS upstream'de tanı hesaplamasının hangi belge sürümüne ait olduğunu güvenilir biçimde taşıyan versioned-push/full-pull desteği geliştirmek. Gelen unversioned bildirime istemci/proxy tarafında körlemesine `version: 1` eklemek ya da version şartını kaldırmak kabul edilemez. Upstream onarımı eski sürüm/ara boş snapshot ve semantic completion regresyonları gerektirir; yalnız bildirime mevcut sürümü eklemek freshness kanıtı değildir. Ürün runtime'ı ve onay/güvenlik sınırları değiştirilmedi.

Kanıt: `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/dragons-real-lsp-stqjDe/evidence.json` — exact command/args, approval kayıtları, capabilities, iki wire tanısı, runtime raporları, sürümler, npm tarball URL'leri ve SHA-512 integrity. İzole kurulumun `package-lock.json` dosyası `lsp-real-acceptance-deps/` altında. Sunucu workspace'i yalnız sentetik scratch projesidir; özel repo sunucuya açılmadı. Canlı model/provider, GUI/PTY veya kurulu platform kabulü yok; 2.1 kapanmadı, 2.2 başlamadı.

## Bounded alternative-server acceptance — native TypeScript FULL pull

Two public upstream candidates were inspected **before installation/execution**:

- **vtsls**, commit `8284c906913683c0cc354a46daa4e5278b305fb7`: rejected for this contract. Its [capability table](https://github.com/yioneko/vtsls/blob/8284c906913683c0cc354a46daa4e5278b305fb7/packages/server/src/capabilities.ts) does not advertise `diagnosticProvider`; its [diagnostic delegate, lines 103–106](https://github.com/yioneko/vtsls/blob/8284c906913683c0cc354a46daa4e5278b305fb7/packages/service/src/service/delegate.ts#L103-L106) publishes `{ uri, diagnostics }` without document `version`. It was not installed or run.
- **Microsoft TypeScript native preview**, npm `@typescript/native-preview@7.0.0-dev.20260707.2` and matching `@typescript/native-preview-darwin-arm64`, registry `gitHead` `9977d6d38fcc78de8ae71770f3aa08256e6cc861`: compatible source contract. [server.go](https://github.com/microsoft/typescript-go/blob/9977d6d38fcc78de8ae71770f3aa08256e6cc861/internal/lsp/server.go#L1096-L1101) advertises `diagnosticProvider`; [diagnostics.go](https://github.com/microsoft/typescript-go/blob/9977d6d38fcc78de8ae71770f3aa08256e6cc861/internal/ls/diagnostics.go#L25-L43) returns FULL document reports; [CLI](https://github.com/microsoft/typescript-go/blob/9977d6d38fcc78de8ae71770f3aa08256e6cc861/cmd/tsgo/lsp.go#L20-L34) supports `--lsp --stdio`. This is a maintained Microsoft upstream **preview**, not a stable-server endorsement or full TypeScript compatibility claim.

Pinned installation used `npm install --prefix <active-profile-scratch>/lsp-native-acceptance-deps --ignore-scripts --no-audit --no-fund --save-exact --registry=https://registry.npmjs.org @typescript/native-preview@7.0.0-dev.20260707.2`. No global/repository dependency or configuration changed. The harness accepts optional third argument `native` (default remains `tls`), executes the package's real native binary, and observes untouched stdout; no transport proxy, version injection, or freshness relaxation is involved.

**Result: this native-server live LSP acceptance passed.** `node --check tests/acceptance/lsp-real-server.mjs` passed, followed by:

```sh
node tests/acceptance/lsp-real-server.mjs \
  /Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch \
  /Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-native-acceptance-deps native
```

- Production `runAgent` handled synthetic `a.ts` WRITE, subsequent correction and model continuation via the deterministic credential-free model adapter. This is a real language-server run, **not** a live external LLM/provider test.
- LSP disabled: no server process, no LSP continuation. EXECUTE denied: no server process, denial text reached continuation. Approved: exactly two fresh native server processes; both exited (PID absence checked after the run).
- First untouched response, request id `2`: `kind: "full"`, one diagnostic `code: 2322`, `source: "ts"`, `Type 'string' is not assignable to type 'number'.` Correction response: `kind: "full", items: []`.
- Both initialize responses advertised document diagnostics. Production continuation included `LSP a.ts: 1 reported diagnostic(s)` with that error, then `LSP a.ts: no diagnostics reported`. The harness records the actual continuation tool outputs, not merely event callbacks.
- `accepted`, `wireSemanticError`, and `wireCorrectedEmpty` were all `true`; unchanged snapshot/version safeguards remained active. Prior `typescript-language-server@5.0.0` incompatibility is not reclassified.

Local evidence:

- `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/dragons-real-lsp-jOIe2e/evidence.json` — exact npm resolutions/integrities, server argv/cwd/PIDs, untouched capabilities/FULL responses, approvals and continuation outputs.
- Sibling `provenance.json` — SHA-256 of executed native binary, evidence, harness, production source/build artifacts, and immutable upstream URLs.
- `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/scratch/lsp-candidates-source/` — upstream source snapshots, npm metadata and source URL index. Scratch evidence is local/ephemeral; do not treat it as committed durable artifacts.

Only this opt-in harness and this evidence document changed in this follow-up. No production source, repository dependencies/config, roadmap completion, LSP2.2 work, commit or push. The existing `1201 pass / 2 skip` deterministic gate was not rerun or superseded. This successful narrow acceptance does not itself close the milestone: retain the preview pin as an explicit opt-in compatible server, and decide stable/default server policy separately rather than accepting unversioned push.
