# Faz 1 geliştirme ve kabul matrisi

Bu belge çalışma/kabul sözleşmesidir; işaretlenmemiş ölçütler uygulama veya başarı iddiası değildir. Kaynak kapsamı `ROADMAP.md` 1.1–1.5; Faz 2 dahil değildir.

## 2026-09-22 inceleme düzeltmeleri: scoped geliştirme kabulü tamamlandı

Bu kayıt önceki geliştirme kabullerini silmez; 13 bulgunun ve yeniden incelemede bulunan ek OAuth/Desktop yaşam döngüsü açıklarının onarım kapsamını ayrı izler. Scoped geliştirme kabulü tamamlandı; yayın veya gerçek platform kabulü değildir.

| # | Uygulanan düzeltme | Kaynak / regresyon |
|---|---|---|
| 1 | Git READ yardımcı çalıştırma engeli; otomatik change-review aynı ortak korumayı kullanır | `src/read-only-git.ts`, `src/tools.ts`, `src/change-review.ts`; `tests/core/runtime-security-regressions.test.ts` |
| 2 | Checkpoint dışı write için dangling son symlink reddi | `src/tools.ts`; aynı runtime regresyonu |
| 3 | Nested subagent READ yetkisini koruma, delegation için ayrı onay | `src/subagents.ts`; aynı runtime regresyonu |
| 4 | Background admission rezervasyonu, claim/save/diagnostics hatasında temizlik | `src/persistent-background-jobs.ts`; aynı runtime regresyonu |
| 5 | OpenAI env dahil HTTPS endpoint ve redirect reddi | `src/provider/openai.ts`; `tests/provider/auth-boundaries.test.ts` |
| 6 | Restart sonrası explicit named-slot için doğrulanmış version-1 OS kaydı recovery; raw/unverified reddi | `src/provider/api-key-auth.ts`; auth-boundaries |
| 7 | Slot adlarında ortak grammar ve belgelenmiş **8** kapasite sınırı | api-key-auth; `tests/provider/api-key-pool.test.ts` literal 8 testi |
| 8 | Registry genelinde paylaşılan auth cache yerine model başına facade; explicit slot downgrade reddi | `src/provider/builtins.ts`; auth-boundaries, api-key-auth testleri |
| 9 | Logout ile yarışan OAuth refresh’in credential geri yazmasını engelleme | `src/provider/codex-auth.ts`; auth-boundaries |
| 10 | Native backend ilk erişimde kullanılamazsa fallback; seçili/önceden kullanılabilir backend hatasında downgrade reddi | `src/provider/credential-store.ts`; auth-boundaries |
| 11 | Desktop secret-dialog dosyalarını paket listesine dahil etme | `electron-builder.json`; `tests/desktop/desktop-package.test.mjs` |
| 12 | Slash komutu sırasında renderer aktif run kimliğini ve iptalini koruma | `desktop/renderer.js`; `tests/desktop/desktop-renderer.test.ts` |
| 13 | Tekrarlanan quit girişimlerinde cleanup bariyerini koruma | `desktop/main.mjs`; `tests/desktop/desktop-main-lifecycle.test.ts` |

Slot inventory/list ve cooldown süreç-yereldir; secret keşfi veya kalıcı health telemetrisi yoktur. Explicit seçim doğrulanmış `ready` OS kaydını geri alabilir; eski raw/unverified kayıt için remove/re-add gerekir. Native depoda atomik cross-process transaction garantisi yoktur. Modelin credential çözümü tembel gerçekleşir; devam eden model pinini değiştirmez.

Doğrulama kayıtları profil scratch altında: `dragons-review-integration-red.log`, `dragons-review-integration-focused.log`, `dragons-review-release-check-final.log`. RED koşusu 17 testte 4 beklenen hata gösterdi: otomatik review fsmonitor/clean/process çalıştırıyordu ve slot sabiti 16 idi. Son kaynak değişikliğinden sonra ana ajan `pnpm release:check` çalıştırdı: 1166 toplam, 1164 başarılı, 2 atlanan, 0 hata; typecheck/build/package PASS, exit 0. Nihai log: `dragons-review-release-final-v2.log`. Son bağımsız salt-okunur inceleme PASS; ek doğrulanmış blocker bulunmadı. Ek regresyonlar `tests/provider/codex-auth-races.test.ts` içinde migration/status/login ile logout sıralamasını ve dört OAuth POST redirect reddini; Desktop lifecycle testleri açılış sırasında quit ve geç runtime disposal davranışını kapsar.

Açık sınırlar: gerçek native OS-store ve Windows/Linux/Electron kurulu paket kabulü, canlı provider doğrulaması ve M78 üretim kapıları. `AGENTS.md` korumalı dosya onayı zaman aşımı nedeniyle değiştirilmedi; odaklı testler `pnpm build:tests` ardından `.test-build/` içinden çalışır, `dist/` yalnız üretimdir. Commit/staging, canlı credential veya yayın işlemi yoktur.

## 1.1 — Mevcut ürün

Önceki başarılı kanıtlar `cli-desktop-user-acceptance.md` ve `m78-secure-auto-update.md` içindedir. M78 native entegrasyon, güvenilir yayın/imza ve gerçek platform kabulü açık kalır. Laboratuvar testleri üretim updater kabulü değildir. Kullanıcı, bu açıklar varken bağımsız 1.2–1.5 geliştirmesini yetkilendirdi.

## 1.2 — Checkpoint ve Rollback

### Nihai geliştirme kabulü — 2026-09-18

**Kabul edildi: desteklenen normal-workspace kapsamı.** Yeni dosya, silme, mevcut alt dizinlerde düzenleme, otomatik bounded snapshot, sayfalı diff ve seçmeli WRITE-onaylı rollback gerçek CLI/Desktop/runtime yollarına bağlıdır. Önceki aşağıdaki açık kayıtlar tarihsel checkpoint'lerdir; bu nihai kayıt kapsamındaki düzeltmelerle geçersiz kalan engeller yeniden açılmaz.

- Ana ajan son kaynakta `pnpm release:check` doğruladı: **1058 başarılı / 2 atlanan / 0 hata**, toplam 1060; typecheck/build/package PASS. Log: `/tmp/dragons-phase1-checkpoint-final-gate.log`.
- Kaynak/test kanıtları: `checkpoint-large-file`, `checkpoint-diff`, `checkpoint-structural-fs`, `checkpoint-structural-integration`, `checkpoint-chain`, `checkpoint-lifecycle`, `desktop-checkpoint-diff` ve mevcut checkpoint/coverage/sensitive/approval/eviction regresyonları. Yeni zincir düzeltmesinden önceki 129 test ve sonraki odaklı 19 test sayıları gate ile örtüşür, toplanmaz.
- Bağımsız `deleg_840be109` incelemesinin eski-inode rollback zinciri engeli giderildi. `deleg_e16285a9` hedefli yeniden inceleme PASS; normal ve kısmi rollback receipt'leri yalnız aynı-session önceki exact kimlik/mod/içerik/topoloji eşleşmelerini günceller. Harici aynı-içerikli replacement hâlâ reddedilir. İnceleme boyunca kaynak hash'leri değişmedi; gate tekrar edilmedi.
- Kullanıcı açıkça normal geliştirme workspace'inde gözlemlenebilir dış değişiklikleri reddeden modeli seçti. Düşmanca eşzamanlı kontrol–syscall yarışı için atomik izolasyon/sandbox garantisi yok. Symlink/hardlink kontrolleri kaldırılmadı.
- Görüntü başına 256 KiB; batch ve history 2 MiB; 32 checkpoint. History yalnız RAM/session ömründe; süreç yeniden açılışında geri yüklenmez. `/clear` conversation-only; checkpoint korunur. Büyük diff yerel READ sayfalarıyla incelenir; dosya seçimi JSON-quoted exact path destekler.
- Credential dosyaları ve tanınan hassas before/after içerik dışlanır; lexical politika evrensel secret detector değildir. Eksik parent dizin yaratılmaz. O_NOFOLLOW olmayan platform structural backend'i desteklemez; native Windows/Linux kabulü yayın kapısında bekler. Shell/MCP/EXECUTE yan etkileri kapsam dışıdır. Bu kabul tüm platformlarda sınırsız dosya/atomik transaction iddiası değildir.

### Tarihsel geliştirme kayıtları

**Kabul durumu: açık, bağımsız inceleme engelli.** İlk uygulama ve takip eden test çalışmaları zaman sınırına ulaştı; derlemenin geçmesi tamamlanma sayılmadı. İnceleme şu somut başlıkları açtı; eşzamanlı düzeltmeler mevcut kaynakta yeniden doğrulanmadan kapatılmayacak:

- Kontrol edilen descriptor/path ile mutasyon arasında dosya/hardlink/üst dizin değişimi.
- Yazım sonrası harici içeriğin agent'a ait after-image olarak benimsenmesi.
- Kısmi yazım/çoklu dosya hata yollarında recovery kanıtı ve changedPaths doğruluğu.
- `client_secret`, `aws_secret_access_key`, credential taşıyan `DATABASE_URL` dışlamaları.
- 17. oturumda aktif geçmiş eviction ve eski checkpoint ID'sinin yeni içeriğe bağlanması.

Kaynak: bağımsız salt-okunur inceleme `deleg_0089146a`, görev 2. Dosya düzeltmeleri ve aktif-history admission regresyonları ayrı kapsamlarla yürütülüyor. Bu bulguların açık olması yeni özelliğin güvenli kabul edildiği anlamına gelmez.

### 2026-09-11 — kısıtlı uygulama ve ana ajan doğrulaması

- **Uygulandı:** aynı doğrulanmış descriptor üzerinden yazım, keyfi harici after-image benimsemenin kaldırılması, belirsiz kısmi değişikliklerin `changedPaths` ile bildirilmesi, ek hassas alan dışlamaları ve UUID namespace içeren checkpoint kimlikleri. Patch parser artık yeni satır sayısını da doğrular.
- **Doğrulandı:** ana ajan önce hatalı yeni satır sayısının kabul edildiği regresyonu yeniden üretti; düzeltme sonrası `pnpm build && node --test --test-reporter=dot dist/checkpoint.test.js dist/tools.test.js` başarılı: 35 test, hata yok. Bu kanıt tam release gate veya bağımsız yeniden inceleme değildir.
- **Güncel kapsam ve yerel engel:** snapshot yalnız workspace kökündeki mevcut normal dosya düzenlemelerini kapsar. `classify()` tüm batch güvenlik/çatışma kontrollerinden sonra güvenli fakat kapsam dışı yeni dosya, silme ve alt dizin işlemlerini mevcut onaylı tool yoluna yönlendirir; `outside rollback coverage` uyarısı üretir. Güvenlik reddi veya `mutate()` hatası sonrası alternatif yazma denemesi yoktur. Bu işlemler için otomatik snapshot/restore ve 16 KiB üzeri dosya desteği hâlâ eksiktir; Windows/Linux kabulünü beklemek tek başına çözüm sağlamaz.
- **Açık güvenlik sınırı:** descriptor doğrulaması sonrasında eşzamanlı OS yazıcısını atomik olarak dışlama garantisi yoktur. Belirsiz kısmi yazımların tam recovery snapshot'ı garanti edilmez. Aktif-history eviction düzeltmesi ve bağımsız yeniden inceleme henüz bu kanıta dahil değildir.
- **Ayrı runtime doğrulaması:** aktif ve pending-admission oturum geçmişleri tahliyeden korunur; 16 geçmişin tamamı meşgulse yeni kabul reddedilir. Ana ajan `pnpm build && node --test --test-reporter=dot dist/runtime-checkpoint-eviction.test.js dist/runtime.test.js` ile 11 testi doğruladı. `deleg_ba2bec42` raporundaki eski patch satır-sayısı hatası yukarıdaki parser düzeltmesiyle giderildi; bu tarihsel hata başarılı güncel kanıtı yeniden açmaz. Bağımsız yeniden inceleme hâlâ bekleniyor.
- **Son odaklı checkpoint kanıtı:** `pnpm build && node --test --test-reporter=dot dist/checkpoint*.test.js dist/tools.test.js` ana ajan tarafından doğrulandı: 77 başarılı test. Kapsam sınıflandırması, karma batch güvenlik retleri, genişletilmiş credential alan/URI dışlamaları ve kısmi mutation/rollback hata çıktısındaki kaçışlanmış yol listesi dahildir. CLI/Desktop'un provider yanıtına ihtiyaç duymadan hata yollarını göstermesi ayrı entegrasyon çalışmasıdır; bu test sayısı o kabulü içermez.

- [ ] Onaylanan built-in dosya WRITE değişiklikleri öncesi bounded snapshot; reddedilen araçta snapshot/mutasyon yok.
- [ ] CLI ve Desktop üzerinden yerel liste, diff ve dosya seçmeli rollback; model isteği yok.
- [ ] Restore mevcut WRITE onayından geçer; tek araç otoritesi `runAgent()` korunur.
- [ ] Yeni dosya, silme ve çoklu dosya patch davranışları testli.
- [ ] Dışarıdan değiştirilmiş dosya sessizce ezilmez; kısmi geri yükleme davranışı açık.
- [ ] Workspace/symlink/hardlink sınırları ve credential dosyası dışlamaları testli.
- [ ] Oturum izolasyonu, bellek/boyut sınırı, hata ve kapanış temizliği testli.
- [ ] Bağımsız güvenlik incelemesi bulguları mevcut kaynakta çözümlü; son kaynak gate'i kayıtlı.

### CLI/Desktop kısmi hata görünürlüğü — 2026-09-11

- **Uygulandı:** başarısız WRITE sonucundaki belirsiz değişen yollar, modelin tekrar etmesine gerek kalmadan CLI renderer ve runtime → Desktop bridge → renderer akışında uyarı olarak sunulur. Yol listesi sınırlandırılır, kontrol karakterleri etkisizleştirilir ve mevcut redaction politikasından geçirilir.
- **Doğrulandı:** ana ajan `pnpm build && node --test dist/partial-failure-ui.test.js` çalıştırdı: 3/3 başarılı. Gerçek dosyada enjekte edilmiş kısmi yazma CLI ve Desktop bridge/renderer VM üzerinden görünür oldu; bounded/escaped/redacted sunum testi geçti. Bu kanıt gerçek Electron/native platform görsel kabulü değildir.
- **Bağımsız inceleme:** `deleg_dde8ec07` covered yazım görünürlüğü, admission/history ve WRITE onayı için önceki düzeltmeleri doğruladı; legacy kısmi hata yollarının kaybolması (P1) ve başarılı kapsam dışı yazma uyarısının CLI'da görünmemesi (P2) bulgularını açtı.
- **Takip düzeltmesi ve ana ajan kanıtı:** legacy yazma/edit/patch hatalarında tamamlanan ve o anda denenen yollar bounded `changedPaths` içinde korunur; `rollbackCoverage` metadata başarılı CLI işlemlerinde de görünür. Ana ajan `pnpm build && node --test --test-reporter=dot dist/checkpoint-coverage.test.js dist/partial-failure-ui.test.js dist/tools.test.js` ile 32/32 testi doğruladı. Bu kanıt önceki 3 UI testini içerir; sayılar toplanmaz. Düzeltme sonrası bağımsız salt-okunur inceleme `deleg_56675d37`, P1/P2 onarımlarına PASS verdi; kapsam dosyalarının hash'leri inceleme boyunca sabit kaldı. Yeni test çalıştırılmadığından mevcut ana ajan 32/32 kanıtı korunur. Bu onay tam 1.2 kabulü değildir: kısıtlı snapshot kapsamı ve nihai kaynak gate'i açık kalır.

EXECUTE veya harici araç yan etkilerinin otomatik geri alınabildiği iddia edilmez. Snapshot saklama süresi ve yeniden başlatma davranışı uygulamadan doğrulanıp kullanıcı belgelerine yazılmalıdır.

## 1.3 — Provider Fallback

**Altyapı doğrulaması (2026-09-11):** provider hata aşaması metadata'sı eklendi. Ana ajan Anthropic HTTP hata bilgisinin kaybolduğu testi yeniden üretip düzeltti; `pnpm build && node --test --test-reporter=dot dist/provider/*.test.js` başarılı, 101 test. Bu tarihsel kanıt yalnız provider metadata altyapısına aittir; sonraki ürün bağlantısı aşağıda ayrı kaydedilmiştir.

**Uygulandı:** varsayılan kapalı, en fazla üç exact provider/model hedefi ve `allow-context-sharing` onayı içeren config; registry üzerinden runtime ve CLI fallback. Interactive/runtime hedef kimliği hedef isteğinden önce kaydedilir; plain tek-atımlık CLI kimliği yalnız süreç içinde benimser, mevcut davranışı gereği session kaydetmez. Child/background akışları kimlik benimseme yetkisi olmadan fail-closed kalır.

**Ana ajan doğrulaması:** build + `dist/cli-fallback.test.js dist/cli.test.js` 47/47; ayrı son build + `dist/runtime-fallback.test.js` 8/8 geçti. CLI switch/save/resume, adoption/target failure ve kayıt sonrası iptal; runtime hedef hatasında doğru durable kimlik/boş continuation ve adoption kaydı beklerken gerçek `run.cancel()` ile hedef çağrısının engellenmesi kapsanır. Önceki registry/fallback/request-failure 42 test kanıtıyla bu sayılar örtüşebilir, toplanmaz. Canlı provider isteği yapılmadı.

**Diagnostics uygulandı ve doğrulandı:** aynı çalışmanın provider/model kimliği adoption sonrası güncellenir; güvenli başlangıç kimliği ve son üç geçiş bounded tutulur. Ana ajan `pnpm build && node --test --test-reporter=dot dist/diagnostics.test.js dist/cli-fallback.test.js dist/cli.test.js dist/runtime-fallback.test.js dist/runtime.test.js dist/provider/fallback.test.js` ile 83/83 testi doğruladı. Bu sayı önceki odaklı kapsamlarla örtüşür, toplanmaz.

**Bağımsız inceleme:** önceki `deleg_726f30a4` zaman aşımı INCOMPLETE olarak korunur; ardından `deleg_a41dbc80` iki ayrı salt-okunur kapsamda geçiş/iptal/araç tekrarı ve host kimliği/persistence/privacy için PASS verdi. Bu sonuç tüm Faz 1 kabulü değildir.

**Release gate:** ana ajan `pnpm release:check` çalıştırdı. İlk koşuda M47'nin iki eski kesin sonuç beklentisi yeni `rollbackCoverage` alanıyla uyumsuzdu; beklentiler metadata'yı da doğrulayacak biçimde güncellendi. Son koşu başarılı (exit 0): `/tmp/dragons-phase1-fallback-release-check-final.log`. Ürün güvenlik koşulları gevşetilmedi. Bu kanıt sonraki Credential Pools kaynak değişikliklerini kapsamaz. Child/background fallback bilinçli fail-closed kalır; bu kapsam sınırı ve diğer Faz 1 eksikleri kapanmış sayılmaz.

**Güncel kabul ve son entegrasyon (2026-09-22):** önceden mevcut fallback çekirdeği, config/registry, CLI ve runtime bağlantıları yeniden incelendi. Eksik görünür diagnostics bağlantısı tamamlandı: biçimlendirilmiş diagnostics, yalnız güvenli başlangıç ve bounded hedef kimlik geçmişini gösterir; prompt, context-sharing onayı, istek veya credential içermez. `src/diagnostics.test.ts`, bu yüzeyi gerçek formatter üzerinden kapsar. Ana ajan son maddi kaynakta `pnpm release:check` doğruladı: **1060 başarılı / 2 atlanan / 0 hata**, toplam 1062; typecheck/build/package PASS. Canlı provider çağrısı yapılmadı; Windows/Linux native kabulü ve M78 üretim updater kapıları ayrı yayın kabulü olarak açık kalır.

- [x] Varsayılan kapalı, bounded ve açıkça yapılandırılmış hedef zinciri.
- [x] Zincir yapılandırması güncel istek ve eklenmiş proje/skills/memory bağlamının belirtilen hedeflere gönderilmesini açıklar; Local için örtülü bulut hedefi yok.
- [x] Yalnız güvenilir typed geçici/rate-limit hatasında, ilk başarılı yanıt ve stream başlangıcından önce geçiş.
- [x] Sıfır metin/tool-only stream başlangıcı da geçişi engeller.
- [x] Resume/continuation/tool çıktıları ve başarılı yanıt sonrası adapter/account değişimi engelli.
- [x] `runAgent()` yeniden başlatılmaz; yürütülen WRITE/EXECUTE yinelenmez.
- [x] CLI/runtime/child fabrikaları tutarlı, seçilen gerçek provider/model kimliği persistence ile uyumlu.
- [x] İptal, zincir/bütçe sınırı, auth/entitlement/protocol reddi ve içeriksiz görünür teşhisler testli.

## 1.4 — Credential Pools

**Nihai geliştirme kabulü — 2026-09-22.** API-key provider başına en fazla sekiz named slot, yalnız OS credential store’da doğrulanmış secret ile uygulanmıştır. Config yalnız provider→slot referansı taşır. TUI ve yerel Desktop masked ekleme, slot adı + güvenli `ready`/`unverified`/`cooldown` durumunu listeleme ve slot silme sunar; secret renderer, IPC, config, session, diagnostics veya çıktıya aktarılmaz. Remote Desktop bu kontrolleri açmaz.

Registry slot seçiminin kopyasını saklar; her yeni model örneği ayrı auth facade oluşturur ve ilk credential çözümünü (hata dahil) kendi ömrüne pinler. Eksik/unverified/cooldown’daki explicit slot yeni run için fail-closed olur ve environment credential fallback’e düşmez. 429 yanıtları `Retry-After` ile veya 30 saniyelik varsayılanla, en çok beş dakika olmak üzere profile–provider–slot namespace’inde sadece süreç belleğinde cooldown kaydeder. Çalışan pinli run başka slota geçmez. Deterministik store, eşzamanlı ekleme, iptal, pinleme, config/registry ve Desktop host izolasyonu regresyonlarla kapsanır.

**Ana ajan gate’i:** `pnpm release:check` başarılı — **1064 başarılı / 2 atlanan / 0 hata**, toplam 1066; typecheck/build/package PASS. İlgili kanıt: `src/provider/api-key-auth.test.ts`, `src/provider/api-key-pool.test.ts`, `src/config-model-id.test.ts`, `src/desktop-slash.test.ts`, `src/desktop-host-isolation.test.ts`, `src/tui-api-key.test.ts`.

Sınırlar: Local provider ve ChatGPT OAuth çoklu hesap/refresh kapsam dışındadır. Canlı provider veya native OS-store/Windows/Linux kullanıcı kabulü iddia edilmez.

## 1.5 — Provider yönetimi

**Nihai geliştirme kabulü — 2026-09-22.** Trusted yerel TUI ve Desktop, ortak `/provider` formatıyla yalnız public registry metadata’sını gösterir: kimlik, etiket, credential yöntemi, adapter default model, curated katalog sayısı, açık adapter capability’leri ve doğrulanmış reasoning metadata varlığı. Bu görünüm erişim/entitlement doğrulaması değildir; provider listeleme açılışta credential, ağ veya model isteği başlatmaz. Named API-key slot/pool durumu, ayrı trusted `/login list <provider>` üzerinden yalnız slot adı ile `ready`/`unverified`/`cooldown` metadata’sı olarak sunulur.

Model picker; configured/default model ve bounded curated exact ID’leri önerir, ancak custom exact ID seçimini engellemez. Curated katalog discovery veya entitlement değildir. Unknown/custom model için reasoning seçeneği gösterilmez; elle gönderilen reasoning komutu da fail-closed olur ve effort iletilmez. Yalnız exact provider-model metadata’sında yer alan seviyeler profile kaydedilir ve sonraki run’a uygulanır.

Runtime/Desktop provider DTO’su `id`, `label`, `defaultModel`, `credentialRequirement`, immutable-copy capability ve opsiyonel bounded catalogue/reasoning metadata ile sınırlıdır. Factory, secret, private endpoint, pool içeriği ve account state dışarıda kalır. Desktop aktif run sırasında güvenli provider listeleme yapılabilir; yeni send/create/resume admissions `BUSY` ile kapalıdır, iptal açık kalır. Eski renderer session ID ile send `STALE_SESSION` olarak reddedilir. TUI/Desktop aynı completion/formatlama yolunu kullanır; plain CLI runtime metadata’sını değiştirmez.

**Ana ajan gate’i:** `pnpm release:check` başarılı — **1067 başarılı / 2 atlanan / 0 hata**, toplam 1069; typecheck/build/package PASS. İlgili deterministik kanıt: `src/slash-choices.test.ts`, `src/provider/model-catalogue.test.ts`, `src/reasoning.test.ts`, `src/tui-controller.test.ts`, `src/desktop-slash.test.ts`, `src/desktop-bridge.test.ts`, `src/desktop-renderer.test.ts`.

Sınırlar: Yeni provider/adaptor, canlı model discovery, account entitlement veya canlı credential doğrulaması eklenmedi. Local provider ve ChatGPT OAuth çoklu hesap/refresh kapsam dışındadır; Windows/Linux native kullanıcı kabulü yayın öncesi kapılarda açık kalır.

## Ertelenen toplu Windows/Linux kabulü

Her testte kullanılan kaynak/paket hash'i, OS/mimari, beklenen/gerçek sonuç ve credential içermeyen kanıt kaydedilir. Önceki Windows paket başarısı yeni kaynak için kabul sayılmaz.

- [ ] CLI/Desktop açılış, workspace, model/reasoning ve auth iptal/toparlanma.
- [ ] 1.2 yeni dosya/patch/diff/selective rollback, WRITE ret ve harici düzenleme çatışması.
- [ ] 1.3 ağsız injected adapter ile fallback ve stream sonrası geçiş reddi.
- [ ] 1.4 kullanıcı tarafından özel alana girilen credential ile native OS-store slot yaşam döngüsü; model çağrısı olmadan doğrulama.
- [ ] M78 için ayrıca gerçek install → update → failure → recovery matrisi; çalışır updater ve yetkili artifact olmadan başlatılmaz.

## Kanıt kuralları

Alt ajan özeti ana ajan doğrulaması değildir. Odaklı testler iterasyon içindir; milestone son maddi değişikliğinde `pnpm release:check` bir kez çalıştırılır. Değişmemiş başarılı gate salt-okunur inceleme nedeniyle tekrarlanmaz. Atlanan native testler geçmiş sayılmaz. Commit/push/yayın/tag/sürüm değişikliği ve gerçek kurulu uygulama değişikliği bu hedefin yetkisi kapsamında değildir.
