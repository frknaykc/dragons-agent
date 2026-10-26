# CT05 — Terminal teslim kapsamı ve aday kabulü

## Ayrı aday — 2026-10-26

Kullanıcı ayrı aday doğrulaması, ayrı dal commit/push ve CI takibini onayladı. Dal: `ci/terminal-ct05`; taban: `470aa97313db3dcbaa68e8f5c1deae53e02cbc4c`. Main merge, tag, sürüm değişikliği veya yayın yok. İlk aday 24 yol; aşağıda açıklanan Windows paket kapısı onarımıyla toplam **26 yol**. Asıl karma çalışma ağacı korunur. Aşağıdaki ilk kapsam incelemesi ve CT03/CT04 belgeleri tarihsel kayıttır, aday sonucu değildir.

Seçilmiş manifest ile lockfile yeniden üretildi. İlk güncel `pnpm audit --prod` dört açık bildirdi: Zod `GHSA-mrhx-c7xc-m3w5`; Undici `GHSA-xjj6-f33q-929c`, `GHSA-4qv8-2p9j-2685`, `GHSA-f72v-6w45-q472`. Yalnız bu geçişli paketler mevcut sürüm aralıkları içinde paket yöneticisiyle güncellendi: **zod 4.6.7, undici 7.30.1** (aynı seçimin tooling dalı: **undici 6.29.1**). MCP client/server/core **2.3.0**; OpenAI **7.9.0** ve diğer doğrudan bağımlılıklar değişmedi. Ertelenen canvas/PDF/XML/ZIP bağımlılıkları taşınmadı.

İlk uzak koşu: [`cdde56059afd1f4a1aa340d3369c4ff6eb08f453` / 40286247011](https://github.com/frknaykc/dragons-agent/actions/runs/40286247011), **FAIL**. Üç terminal test kümesi **1144 PASS / 0 FAIL / 4 skip**; üç global typecheck PASS; macOS/Ubuntu kurulu paket ve PTY PASS. Windows kurulu paket adımı `LICENSE` CRLF satır sonlarını LF-only regex ile reddetti. Desktop/Web üç işi PASS. Bu koşu üç hedef teslimat kabulü değildir.

Bu somut platform kusuru için iki yeni aday yolu: `scripts/verify-package.mjs` ve `tests/scripts/package-commands.test.mjs`. Yalnız lisans doğrulama yardımcı fonksiyonu ve LF/CRLF/yanlış içerik regresyonları eklendi; ana ağaçtaki ertelenmiş exports değişikliği alınmadı. Gerçek LICENSE/copyright değişmedi, yanlış lisans/holder/placeholder reddi korundu. Regresyon önce CRLF için **6 PASS / 1 FAIL**, düzeltme sonrası **7/7 PASS**. Aşağıdaki yeni CI'da Windows kurulu paket kontrolü de PASS.

Son maddi kaynak: macOS arm64, Node **v22.22.3**, pnpm **11.17.0**. Markdown hariç 444 kaynak/config/test yolunun `path + NUL + SHA256(bytes) + LF` sıralı kayıtları için SHA-256: `f8d2c6bf804a91a51618274a77ddd851b15e601bbeebd398ba91038707224a32`. Yol kümesi tabanın tracked Markdown-dışı dosyaları ve bu kapsamdaki yeni test dosyalarıdır; generated/build çıktıları dahil değildir. Bu digest commit SHA değildir; sonraki yalnız-belge değişikliği test edilen kaynakla karşılaştırılabilir.

| Aday kontrolü | Sonuç |
|---|---|
| Frozen install | PASS |
| Composition/controller/skills, MCP ve suite-runner odakları | **79/79**, exit 0 (son transitive güvenlik güncellemesinden önce; aşağıdaki tam gate bu testleri son kaynakta yeniden kapsar) |
| Son kaynak `pnpm release:check` | **1523 toplam / 1517 başarılı / 0 hata / 6 skip**, exit 0; global typecheck/build ve `PACKAGE_ACCEPTANCE_OK`, `RELEASE_CHECK_OK` |
| İzole yerel POSIX PTY / shared-runtime PTY | **10/10 + 10/10**, exit 0; fixture provider, canlı inference değil |
| `pnpm audit --prod` | **Bilinen açık yok**, exit 0 |

Mac atlamaları: desteklenmeyen checkpoint platformu senaryosu, üç Windows checkpoint senaryosu ve iki Linux AppImage worker senaryosu. Atlamalar native kabul sayılmaz. Eski geniş dirty ağacın Web Dashboard hatası bu adayda taşınmadı veya düzeltilmiş sayılmadı; tabandaki mevcut Desktop/Web testleri tam gate içinde korundu.

## Aynı commit üç hedef kabulü — 2026-10-26

**CT02/CT03/CT05, yalnız tanımlanan CI/fixture kapsamıyla PASS.** Kaynak commit: `458b73ad64bdc13791ce9dd9918d7a176e73336e`; [GitHub Actions 40287586759](https://github.com/frknaykc/dragons-agent/actions/runs/40287586759), altı işin tamamı PASS. Koşu SHA'sı yerel ve uzak dal SHA'sıyla eşleştirildi. Aşağıdaki sayılar iş loglarındandır; test dosyasını okumaya veya eski dirty ağaç sonuçlarına dayanmaz.

| Terminal hedefi | Runner / Node | Testler (toplam / PASS / FAIL / skip) | Frozen install / global typecheck / kurulu paket | PTY |
|---|---|---|---|---|
| macOS arm64 | `macos-15`, `darwin/arm64`, `v22.23.2` | **1151 / 1147 / 0 / 4** | PASS / PASS / PASS | POSIX fixture 10/10 |
| Windows x64 | `windows-2022`, `win32/x64`, `v22.23.4` | **1151 / 1147 / 0 / 4** | PASS / PASS / PASS | Çalıştırılmadı; POSIX adımı koşullu skip |
| Ubuntu LTS x64 | `ubuntu-24.04`, `linux/x64`, `v22.23.3` | **1151 / 1147 / 0 / 4** | PASS / PASS / PASS | POSIX fixture 10/10 |

- Her terminal işinde OS/arch doğrulaması ve `PACKAGE_ACCEPTANCE_OK dragons-agent-0.1.0.tgz` var. Test kümesi gerçek CLI/TUI composition, fixture provider ile stream/onay-ret/iptal/persisted resume ve seçilmiş extension yollarını kapsıyor; canlı inference değil.
- macOS/Ubuntu terminal skip'leri: desteklenmeyen checkpoint platformu ve üç Windows checkpoint testi. Windows terminal skip'leri: desteklenmeyen checkpoint platformu ve üç home-less senaryosu (Windows native home çözümlemesi). Windows checkpoint testleri Windows'ta çalıştı.
- Ayrı Desktop/Web işi: macOS **372 / 370 / 0 / 2**, Ubuntu **372 / 369 / 0 / 3**, Windows **374 / 335 / 0 / 39** (toplam / PASS / FAIL / skip). Platform koşullu native testler atlanır; bu sonuç ertelenen yeni Desktop/Web farklarına veya native üretim dağıtımına kabul vermez. Hiçbir iş `continue-on-error` ile gizlenmedi.
- Ana çalışma ağacında başlangıç envanterinin **147 dosya hash'i** korundu; ROADMAP'ın önceki kapsam notu dışında değişiklik yok. `main` HEAD/index ve `AGENTS.md` korunur. Adayda yalnız tanımlı 26 yol; hariç bırakılan önceki farklar taşınmadı.
- Kabul kaydı güncellemesi yalnız Markdown'dır; yukarıdaki 444-yol kaynak digest'i değişmedi. Bu kayıt kaynak commit'in kanıtıdır, ilerideki değişiklikler için otomatik kabul değildir.

**Açık sınırlar:** Windows ConPTY ve gerçek kullanıcı terminali, canlı provider/ücretli inference, OS credential store, diğer mimari/distro, imzalı üretim dağıtımı/yayın bu kanıtın dışında. CT01'in izin gerektiren `AGENTS.md` yazımı ve CT06 Desktop/Web işleri açık kalır. Main merge, tag veya yayın yapılmadı.

## İlk kapsam incelemesi — 2026-10-26 (tarihsel)

**Kapsam incelemesi tamamlandı; ayrıştırılmış kaynak veya teslimat kabulü tamamlanmadı.**

- Taban: `main`, `470aa97313db3dcbaa68e8f5c1deae53e02cbc4c`.
- İnceleme başlangıcı: **148 yol = 61 tracked değişiklik + 87 untracked dosya**. Index boştu.
- **23 mevcut yol aday: 18 tam dosya farkı + 5 kısmi dosya farkı. 125 yol bu terminal tesliminin dışında.** Bu yeni kapsam kaydı eklendiğinde önerilen teslimat listesi 24 yola çıkar.
- “Tam dosya” tabandaki dosyayı silip yeniden yazma talimatı değildir; mevcut farkın tamamının konuya ait olduğunu belirtir. “Kısmi” dosyalar `git add <dosya>` ile bütün halinde alınmamalıdır.
- Bu tur üretim kodu, dependency veya test değiştirilmedi. Staging, branch oluşturma, commit, push, tag, sürüm artırma, yayın veya repository ayarı değişikliği yapılmadı. `AGENTS.md` engellenen yazımı tekrar denenmedi.
- Önceki Desktop/Web ve diğer işler yerinde kalır. Hariç bırakmak silmek, geri almak veya mevcut çalışma ağacında özellik kapatmak değildir.

## Tam farkı alınabilecek 18 yol

| Yol | Gerekçe |
|---|---|
| `.github/workflows/ci.yml` | Üç hedef CLI/TUI işi; ayrı ve hatayı gizlemeyen Desktop/Web işi. |
| `CONTRIBUTING.md` | Terminal önceliği ve ayrık test komutları. |
| `docs/platform-test-plan.md` | Hedefler, tarihsel kanıt ve CI/gerçek cihaz ayrımı. |
| `scripts/run-tests.mjs` | Kayıpsız terminal/Desktop test seçimi; varsayılan tam küme. |
| `scripts/verify-tui-pty.py` | İptal göndermeden önce provider giriş bariyeri. |
| `src/cli/skills-commands.ts` | Kuyruk/çözümleme sonrası skills iptal kontrolleri. |
| `src/tui/controller.ts` | Geç oturum sonucu iptali; checkpoint/rollback yönlendirmesi ve yardım. |
| `src/tui/local-commands.ts` | Yerel skills callback, session ID ve iptal sinyali. |
| `tests/fixtures/tui-pty-fixture.mjs` | Provider giriş marker dosyası. |
| `tests/integration/m50-streamable-http.test.ts` | SDK 2.3.0 istek başına transport/server sahipliği. |
| `tests/integration/m51-mcp-authentication.test.ts` | SDK 2.3.0 uyumu, eşzamanlı istemci ve peer-close regresyonu. |
| `tests/tui/tui-controller.test.ts` | Geç sonuç iptali ve checkpoint/help regresyonları. |
| `docs/terminal-coding-acceptance.md` | CT03 tarihsel yerel kanıt; yeni adayın kabulü değildir. |
| `docs/terminal-extension-acceptance.md` | CT04 tarihsel yerel kanıt; yeni adayın kabulü değildir. |
| `tests/integration/terminal-coding-flow.test.ts` | Gerçek CLI/TUI coding composition, onay/ret/iptal/resume. |
| `tests/integration/terminal-extension-flow.test.ts` | Gerçek skills/MCP/context/checkpoint/Git/worktree composition. |
| `tests/scripts/test-suites.test.mjs` | Test seçiminin sekiz regresyonu; dosya kaybı/örtüşmesi/boş başarı reddi. |
| `tests/tui/tui-skills.test.ts` | Skills kuyruk iptali ve host/session aktarımı. |

## Kısmi alınması gereken 5 yol

| Yol | Dahil | Dışarıda tutulacak |
|---|---|---|
| `src/cli.ts` | TUI local-command composition'ındaki `skills` callback; aktif oturum/kanonik workspace kontrolü; 16.000 karakter çıktı sınırı. Plain CLI'de caller-owned `dependencies.tools` dizisinin shallow copy'si ve ilgili yorum. | Yeni voice import/komut/dependency alanları; artifact rendering; execution backend, host egress, web research, specialized search, computer-use/browser ve image generator bindings; browser disposal ve voice cancellation/final-response değişiklikleri. |
| `package.json` | `test:terminal` ve `test:desktop` script'leri; MCP client/server **2.0.0 → 2.3.0**. | Yeni package exports, browser seccomp paket dosyası, Desktop smoke script'leri, canvas/PDF/XML/ZIP ve bunların test/type bağımlılıkları. |
| `pnpm-lock.yaml` | Seçilmiş manifest ile eşleşen MCP client/server/core 2.3.0 dependency closure. Ayrı adayda pnpm ile üretim/doğrulama. | Canvas platform paketleri, PDF/XML/ZIP/fflate değişiklikleri. Karışık mevcut lockfile bütünüyle alınmaz; sadece üst sürüm satırlarını değiştirip tutarlı sayılmaz. |
| `README.md` | CLI/TUI önceliği, üç hedef, skills/checkpoint/worktree kullanım/sınır açıklamaları ve ilgili terminal kabul bağlantıları. | Voice kullanım bloğu ve bu terminal dalında bulunmayacak dashboard'a ilişkin güncel ürün iddiaları. Tarihsel Web hata notu gerekiyorsa açıkça büyük çalışma ağacına bağlanır. |
| `ROADMAP.md` | Güncel CLI/TUI önceliği, CT01–CT06 sırası ve mevcut yerel kanıt kayıtları; bu CT05 kapsam notu. | Önceki kapsamlı faz/R01–R12 denetim değişikliklerinin tamamını terminal değişikliği diye taşımak. Ayrılan CT metnindeki bu denetime bağımlı referanslar yeniden bağlamlandırılmalı; tabandaki kayıtlar korunmalı. |

## Bağımlılık sınırında doğrulananlar

- Taban `src/cli.ts` zaten `realpath`, `handleInteractiveSkillsCommand`, `skillsDirectoryFor` ve `createTuiLocalCommands` kullanıyor. Seçili callback için yeni voice/browser/execution import'ları gerekmiyor. Skills handler'ın yeni `signal` alanı ve TUI context/session değişiklikleri beraber taşınmalı.
- Checkpoint servisi ve runtime yetki hattı tabanda mevcut. Controller bağlantısını almak, bu turda `src/runtime.ts` veya `src/agent.ts` içindeki yeni araç/voice değişikliklerini almak anlamına gelmiyor.
- Suite script'leri birlikte taşınmalı: workflow → `package.json` script'leri → `scripts/run-tests.mjs` → regresyon testleri. `pnpm test` tam küme olarak kalır; global build/typecheck daraltılmaz.
- PTY harness ve fixture birlikte taşınmalı; aksi halde harness marker'ı beklerken fixture üretmeyebilir.
- MCP sürümü, lockfile ve iki SDK HTTP fixture düzeltmesi birlikte taşınmalı.
- `scripts/verify-package.mjs` mevcut farkı yalnız ertelenen exports listesini kabul etmek içindir. Dar adayda yeni exports alınmayacağından **bu fark dışarıda**, tabandaki verifier korunur. CI yine `pnpm verify:package` çalıştırır.
- Bu inceleme bağımlılık sınırını belirler; henüz ayrı aday derlenmediği için dependency closure/build PASS iddiası değildir. Yeni adayda kalan tip/import veya test bağımlılığı çıkarsa kapsam yeniden değerlendirilir; hariç işler sessizce eklenmez.

## Onay sonrası sıra ve kabul kapıları

1. Mevcut dirty çalışma ağacı/index korunarak taban commit'ten ayrı bir aday oluştur. Yalnız yukarıdaki farkları taşı; kısmi dosyaları bütün halinde kopyalama. Lockfile'ı seçili manifest ile eşleştir. Bu kapsam belgesini de ekle.
2. Aday diff'ini listeyle karşılaştır; secrets, özel proje verisi, `.env`, local profile, üretilmiş çıktılar ve hariç kaynakların taşınmadığını denetle. Tarihsel CT02/CT03/CT04 kayıtlarını adayın test sonucu gibi sunma; README/ROADMAP referanslarını aday içerikle hizala.
3. Önce etkilenen CLI/TUI composition/controller/skills, MCP ve suite-runner testlerini çalıştır. Son maddi değişiklikten sonra `pnpm release:check` **bir kez**; dependency değişimi için `pnpm audit --prod`; kapsamına uygun izole PTY kabulü. Aynı değişmemiş snapshot için full gate'i tekrarlama. Composite gate testte durursa eksik typecheck/paket sonucunu ayrıca kaydet.
4. Commit/push onayıyla ayrı teslimat dalını GitHub'a gönder; main'e doğrudan yazma, merge/tag/release yapma. Yerel adayın ve uzak commit'in aynı kaynağı taşıdığını doğrula. Onaylı kapsam dışı hata çıkarsa önce raporla.
5. **Aynı commit SHA** için aşağıdaki üç terminal işinin kurulum/test/typecheck/paket adımlarını ve skip sayılarını kaydet. Desktop/Web işi ayrı görünür kalır; `continue-on-error` veya test silme ile yeşile çevrilmez.

| Hedef | Runner | Mevcut workflow kapıları | Kanıt sınırı |
|---|---|---|---|
| macOS arm64 | `macos-15` | OS/arch doğrulama; frozen install; terminal testleri; POSIX PTY; global typecheck; kurulu paket | Canlı provider/native store veya tüm macOS terminalleri değil. |
| Windows x64 | `windows-2022` | OS/arch doğrulama; frozen install; terminal testleri; global typecheck; kurulu paket | Workflow POSIX PTY çalıştırmaz; Windows ConPTY/gerçek kullanıcı terminali kabulü yok. |
| Ubuntu LTS x64 | `ubuntu-24.04` | OS/arch doğrulama; frozen install; terminal testleri; POSIX PTY; global typecheck; kurulu paket | Diğer distro/mimari, gerçek kullanıcı oturumu veya native store kabulü değil. |

**Şu anda uzak koşu yok; CT02/CT05 kapanmaz.** GitHub workflow tanımı ve yerel kaynak incelemesi CI sonucu değildir. Eski dirty ağaçtaki **1727 başarılı / 1 Web hatası / 6 atlama** ile PTY sonuçları tarihsel CT04 kanıtıdır. Özellikle Web Dashboard kodu/testi ayrı adaydan dışlandığında eski hata adayda varmış veya düzeltilmiş gibi gösterilemez; daha büyük çalışma ağacında açık kalır. Yeni adayın tam test sayısı/sonucu ayrıca ölçülür.

## Korunacak fakat bu teslimata alınmayacak 125 yol

Aşağıdaki dışlama yalnız önerilen yeni farklara ilişkindir. HEAD'de zaten bulunan Desktop/Web veya diğer kaynaklar adaydan silinmez. Gerekçe: önceki Desktop/Web, browser/Computer Use, voice/image/document, execution/web-research işleri ve bunların ortak runtime/config/provider entegrasyonları; terminal CT farklarına sahip oldukları varsayılmadı. Son aday testleri bağımlılık gerektirirse değerlendirme yeniden açılır.

- `SECURITY.md`
- `desktop/index.html`
- `desktop/main.mjs`
- `desktop/preload.cjs`
- `desktop/renderer.js`
- `desktop/style.css`
- `docs/advanced-usage.md`
- `electron-builder.json`
- `scripts/verify-desktop-smoke.mjs`
- `scripts/verify-package.mjs`
- `src/agent.ts`
- `src/cli/commands.ts`
- `src/config.ts`
- `src/desktop/bridge.ts`
- `src/desktop/cron-service.ts`
- `src/desktop/host.ts`
- `src/desktop/local-controls.ts`
- `src/desktop/session-loop-service.ts`
- `src/inline-context.ts`
- `src/plugin-catalog.ts`
- `src/provider/builtins.ts`
- `src/provider/fallback.ts`
- `src/provider/openai.ts`
- `src/remote/server.ts`
- `src/runtime.ts`
- `src/terminal/renderer.ts`
- `src/tools.ts`
- `tests/background/persistent-job-rename-cancellation.test.ts`
- `tests/core/agent.test.ts`
- `tests/core/inline-context.test.ts`
- `tests/core/tools.test.ts`
- `tests/desktop/desktop-bridge.test.ts`
- `tests/desktop/desktop-cron-service.test.ts`
- `tests/desktop/desktop-host-isolation.test.ts`
- `tests/desktop/desktop-main-lifecycle.test.ts`
- `tests/desktop/desktop-renderer.test.ts`
- `tests/desktop/desktop-session-loop.test.ts`
- `tests/desktop/desktop-shutdown.test.ts`
- `tests/desktop/desktop-slash.test.ts`
- `tests/integration/m11-runtime.test.ts`
- `tests/provider/fallback.test.ts`
- `tests/provider/openai.test.ts`
- `tests/runtime/remote-server.test.ts`
- `tests/runtime/runtime.test.ts`
- `MACOS_DURUM_RAPORU.md`
- `desktop/browser-container-bridge.mjs`
- `desktop/browser-image/Dockerfile`
- `desktop/browser-image/Dockerfile.dockerignore`
- `desktop/browser-image/README.md`
- `desktop/browser-image/seccomp_profile.json`
- `desktop/browser-image/start-browser.sh`
- `desktop/personal-browser/extension-adapter.mjs`
- `desktop/personal-browser/extension-core.mjs`
- `desktop/personal-browser/page-operations.mjs`
- `docs/dragons-web-dev/2026-10-23-web-dashboard-scoped-gaps-workplan.md`
- `docs/macos-browser-isolation-probe.md`
- `src/artifacts.ts`
- `src/browser-automation.ts`
- `src/browser-cdp-socket.ts`
- `src/browser-egress-proxy.ts`
- `src/browser-stdio-bridge.ts`
- `src/cli/voice-commands.ts`
- `src/cli/voice-playback.ts`
- `src/clipboard-image.ts`
- `src/computer-use.ts`
- `src/configured-browser-tools.ts`
- `src/desktop/git-review.ts`
- `src/desktop/owned-computer-driver.ts`
- `src/desktop/plugin-ui.ts`
- `src/desktop/workspace-browser.ts`
- `src/docker-execution-backend.ts`
- `src/document-extraction.ts`
- `src/document-ocr.ts`
- `src/execution-backend-factory.ts`
- `src/execution-backend.ts`
- `src/host-egress.ts`
- `src/image-generation-tool.ts`
- `src/image-generation.ts`
- `src/isolated-browser-driver.ts`
- `src/isolated-browser-launcher.ts`
- `src/notebook-extraction.ts`
- `src/provider/openai-image-generation.ts`
- `src/provider/openai-voice.ts`
- `src/remote/dashboard.ts`
- `src/singularity-execution-backend.ts`
- `src/specialized-search.ts`
- `src/ssh-execution-backend.ts`
- `src/voice-microphone.ts`
- `src/voice-mode.ts`
- `src/voice-operations.ts`
- `src/voice.ts`
- `src/web-research.ts`
- `tests/cli/voice-commands.test.ts`
- `tests/core/artifacts.test.ts`
- `tests/core/browser-config.test.ts`
- `tests/core/document-extraction.test.ts`
- `tests/core/execution-config.test.ts`
- `tests/core/image-generation-tool.test.ts`
- `tests/core/image-generation.test.ts`
- `tests/core/voice-microphone.test.ts`
- `tests/core/voice-mode.test.ts`
- `tests/core/voice.test.ts`
- `tests/desktop/git-review.test.ts`
- `tests/desktop/owned-computer-driver.test.ts`
- `tests/desktop/plugin-ui.test.ts`
- `tests/desktop/workspace-browser.test.ts`
- `tests/integration/browser-automation.test.ts`
- `tests/integration/browser-cdp-socket.test.ts`
- `tests/integration/browser-configured-tools.test.ts`
- `tests/integration/browser-egress-proxy.test.ts`
- `tests/integration/browser-stdio-bridge.test.ts`
- `tests/integration/computer-use.test.ts`
- `tests/integration/docker-execution-backend.test.ts`
- `tests/integration/isolated-browser-driver.test.ts`
- `tests/integration/personal-browser-adapter.test.mjs`
- `tests/integration/personal-browser-extension.test.mjs`
- `tests/integration/personal-browser-page.test.mjs`
- `tests/integration/remote-dashboard.test.ts`
- `tests/integration/singularity-execution-backend.test.ts`
- `tests/integration/specialized-search.test.ts`
- `tests/integration/ssh-execution-backend.test.ts`
- `tests/integration/web-research.test.ts`
- `tests/provider/openai-image-generation.test.ts`
- `tests/provider/openai-voice.test.ts`
- `tests/provider/voice-operations.test.ts`

## Bu turun doğrulama sınırı

Git status/branch/HEAD/index ve konu diff'leri incelendi; 148 yolun sınıflandırması sayıldı. Liste bir staging allowlist'idir, yürütülmüş staging sonucu değildir. Bu kayıt ve ROADMAP bağlantısı dışında mevcut dosyaların byte bütünlüğü kontrol edilir; Markdown yerel yolları ve `git diff --check` denetlenir. Üretim kodu değişmediğinden önceki büyük çalışma ağacında test/build tekrar çalıştırılmaz. Ayrıştırılmış aday henüz üretilmedi/test edilmedi.
