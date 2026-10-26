# CT04 — Terminal yeteneklerine erişim

> **Tarihsel kaynak:** Bu belge daha büyük 2026-10-23 dirty ağacını anlatır; digest, satır numaraları ve sonuçları ayrı terminal dalının kanıtı değildir. Ayrıştırılmış aday ve yeni sonuçlar için [CT05 kabul kaydı](terminal-delivery-scope.md).

## Kaynak ve kapsam — 2026-10-23

`main` / `470aa97` tabanlı **commit edilmemiş çalışma ağacı**; macOS arm64, Node v22.22.3, pnpm 11.17.0. Mevcut runtime ve servisler kullanıldı; yeni provider, ayrı yetki döngüsü veya TUI framework'ü eklenmedi. Bu kayıt üç platform, canlı servis veya üretim yayını kabulü değildir.

Scoped kaynak kimliği: `c55f07c7943308aaee86d35569ca5c0cc2558b8ef61871fe9a6ae6967770d9db`. Aşağıdaki sıralanmış yolların her biri için `path + NUL + SHA256(bytes) + LF` kayıtlarının birleşiminin SHA-256 değeridir; bütün dirty ağacın veya commit'in hash'i değildir:

- `.github/workflows/ci.yml`, `package.json`, `pnpm-lock.yaml`
- `scripts/verify-tui-pty.py`, `tests/fixtures/tui-pty-fixture.mjs`
- `src/cli.ts`, `src/cli/skills-commands.ts`, `src/tui/controller.ts`, `src/tui/local-commands.ts`
- `tests/integration/terminal-extension-flow.test.ts`, `tests/tui/tui-controller.test.ts`, `tests/tui/tui-skills.test.ts`

Önceki CT03 kaydı kendi kaynak kimliğiyle tarihsel olarak korunur. Bu turun dışındaki Desktop/Web ve diğer çalışma ağacı değişiklikleri silinmedi veya bu tura mal edilmedi.

## Kullanıcı yolu → servis → kanıt

| Yetenek | CLI / TUI giriş noktası | Gerçek servis ve doğrulama | Sınır |
|---|---|---|---|
| Skills | İkisinde de `/skills list`, `show <id>`, `activate <id>`, `deactivate <id>` | TUI yerel host callback'i mevcut `handleInteractiveSkillsCommand` ve session store'a bağlanır. Composition testinde provider context'ine aktivasyon sonrası içerik gelir, deaktivasyon sonrası gelmez; referanslar diskte doğrulanır. | Advisory veri; araç izni değildir. TUI host çıktısı 16.000 karakterde sınırlanır. Remote host metadata'sı bu callback'i oluşturamaz. |
| Skills iptali/oturum | Aktif TUI oturum kimliği ve her komutun `AbortSignal`'ı | Host mevcut workspace oturumunu yükler; `saveSessionSkills` kilit bekledikten ve içerik çözümlendikten sonra iptali kontrol eder. İki deterministik kuyruk regresyonu aktivasyon/deaktivasyonun kaydı değiştirmediğini doğrular. Oturumsuz çağrı reddedilir, geç çıktı gizlenir. | Commit edilmiş mutasyonun disk rollback'i iddia edilmez. |
| Context | CLI/TUI `/context` | Gerçek `main` composition'ında yerel bilgi çıktısı; provider'a slash komutu gönderilmez. | Karakter tahmini, provider token sayımı veya sınırsız dosya eki değildir. |
| MCP | CLI/TUI `/mcp connect <id>`, `/mcp disconnect <id>` | Gerçek `McpClientManager`, yerel stdio fixture ve araç kataloğu; bağlantı durumları doğrulanır. `mcp__fixture__inspect` için varsayılan ret ve açık EXECUTE onayı test edilir. | Uzak gerçek MCP sunucusu veya canlı credential kabulü değil. |
| Session search | Modelin keşfettiği `session_search` / `session_get` READ araçları | Composition, katalog search/describe yolunu kullanıp `session_search` ile geçmiş işaretini bulur. CLI worktree değişimi sonrası eski workspace geçmişi sonuçlara taşınmaz. | Slash komutu değildir. `session_get` mevcut core test kapsamındadır; yeni composition yalnız search çalıştırır. |
| Checkpoint | CLI/TUI `/checkpoint list`, `/checkpoint diff <id>`, `/rollback <id>` | TUI artık bunları reddetmek yerine runtime checkpoint yoluna iletir; picker/help içinde görünürler. Gerçek WRITE sonrası snapshot list/diff, rollback ret/iptal/onay ve dosya içeriği doğrulanır. Provider'a çağrı yapılmadığı sayımla kontrol edilir. | WRITE yetkisi `runAgent`'tadır. 32 kayıt/256 KiB sınırları korunur; shell/MCP yan etkileri ve yeniden başlatma sonrası kurtarma kapsam dışıdır. |
| Git | Modelin `git_status` / `git_diff` READ araçları | Composition gerçek `git_status` çalıştırır; mevcut Git araçları `read-only-git` sınırını kullanmaya devam eder. | Yeni composition `git_diff` çağırmaz; onun kapsamı mevcut core testlerdir. |
| Worktree | **Plain interaktif CLI:** `/worktree create <name>`, `/worktree select <name>` | Gerçek geçici Git deposu: bağlı MCP varken ret; oluşturma/seçme, kaynak untracked dosyanın korunması, hedefe yeni araç bindings, checkpoint/history izolasyonu ve traversal reddi doğrulanır. | TUI oturum içinde workspace değiştirmez. CLI'de oluşturup hedef dizinden `dragons --tui` başlatılır. Bu sınır help/picker testi ve README'de açık; tam gelişmiş özellik eşitliği iddiası yok. |

## Çalıştırılan kontroller

| Kontrol | Sonuç |
|---|---|
| Odaklı composition + TUI controller + skills | **52/52 PASS**; sonrasında worktree kaynak/hedef ayrım assertion'ı güçlendirildi ve tam kümede tekrar geçti. |
| Picker regresyonunun negatif kanıtı | `/checkpoint`/`/rollback` choices eksikliği assertion FAIL; destek listesi/help düzeltmesi sonrası PASS. |
| Son maddi kaynakta `pnpm release:check` | **1734 toplam / 1727 başarılı / 1 hata / 6 atlama**, exit 1; `dragons-ct04-final-release.log`. |
| `pnpm typecheck` | **PASS**, uygulama + test TypeScript. Sonraki tek kod dışı değişiklik PTY Python/MJS fixture senkronizasyonudur; TypeScript değişmedi. |
| `pnpm verify:package` | **PASS**, build ve `PACKAGE_ACCEPTANCE_OK dragons-agent-0.1.0.tgz`; paketlenmeyen PTY fixture düzeltmesi bu kanıtı değiştirmez. |
| `python3 scripts/verify-tui-pty.py` | **10/10 PASS**, `M72_PTY_ACCEPTANCE_OK`, gerçek izole macOS PTY; canlı provider yok. |
| Aynı PTY harness'i `--shared` | **10/10 PASS**, `M75_SHARED_PTY_ACCEPTANCE_OK`; yerel fixture remote/shared runtime yolu, dış servis değil. |
| `pnpm audit --prod`, `git diff --check` | **PASS**; bilinen bağımlılık açığı raporlanmadı. |

Tam gate'in tek hatası önceden açık Desktop/Web R01: `dashboard MCP status is bounded, inert and cleared across reconnects` → `Dashboard state did not settle`. Test silinmedi, atlanmadı veya hatası gizlenmedi. **Tam `release:check` PASS değildir.** Composite gate testte durduğu için typecheck/paket ayrı çalıştırıldı. Altı atlama dört checkpoint platform testi ve iki Linux AppImage worker testidir; platform kabulü sayılmaz.

İlk PTY koşusu, `RUNNING` görünür görünmez iptal gönderip henüz başlamamış provider'dan iptal dosyası beklediği için başarısız oldu. `RUNNING` runtime admission aşamasını da kapsar. Fixture artık provider girişinde `wait-started.txt` üretir; harness iptali bu sinyalden sonra gönderir. Timeout uzatılmadı, üretim iptal kodu değiştirilmedi. Yerel ve shared yollar düzeltmeden sonra ayrı ayrı geçti; son tam gate bu fixture değişikliğinden sonra çalıştırıldı. İlk gate logu `dragons-ct04-release.log` olarak ayrıca korunur; loglar yerel scratch dizinindedir, paket içinde değildir.

## Bağımsız inceleme

2026-10-23, `deleg_d736e63f`: **PASS**, doğrulanmış engelleyici bulgu yok. Salt-okunur inceleme TUI skills/checkpoint bağlarını, runtime yetki hattını, iptal kontrollerini, oturum/workspace sınırlarını ve yeni test assertion'larını kapsadı. Ana oturum mevcut kaynakta skills mutasyon bariyerlerini, workspace kontrolünü ve checkpoint → `runAgent` onay hattını ayrıca karşılaştırdı. İnceleyen test/build çalıştırmadı; yukarıdaki dinamik sonuçların yerine geçmez. Yeni CT04 composition testi MCP EXECUTE iptalini veya TUI üzerinden oturumlar arası checkpoint izolasyonunu doğrudan sınamaz; bu alanlarda yeni dinamik kabul iddiası yoktur. İnceleme üretim kaynağını değiştirmedi; mevcut test kanıtı korundu.

**CT04 seçili yerel erişim kapsamı kapandı.** Uzak platform ve tam release kabulü aşağıdaki nedenlerle açık kalır.

## Açık kabul sınırları

- CT04 seçili yerel kullanıcı yolları doğrulandı; bütün TUI/Desktop özellikleri eşitlendi denmez.
- CT02/CT05: **aynı kaynak için macOS arm64, Windows x64 ve Ubuntu x64 GitHub Actions sonucu yok**. Commit/push yetkisi kullanılmadı; workflow tanımı gerçek uzak kanıt değildir.
- Mac PTY kanıtı Windows/Linux terminal veya ConPTY kabulü değildir. Canlı provider, OS credential store, kişisel browser, mikrofon, ses ve pano kabulleri açılmadı.
- CT01 `AGENTS.md` yazma engeli korunur; dosya değiştirilmedi ve engellenen işlem yeniden denenmedi.
- Desktop/Web R01, CT06 kapsamında açık kalır. Ortak runtime/güvenlik/paket hatası olsaydı terminal kabulünün de engeli olurdu; mevcut tek tam-test hatası Web Dashboard testidir.
- Commit, push, tag, sürüm artışı veya yayın yapılmadı.
