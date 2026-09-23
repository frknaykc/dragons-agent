# DragonsAgent — Yeni Yol Haritası

## Amaç ve mevcut temel

Dragons Agent yol haritası, mevcut runtime, CLI, Desktop, provider, auth, profile, session, memory, skills, MCP, delegation, background jobs ve planlama altyapısının üzerine kuruludur. Mevcut temeller yeniden yazılmayacak; eksik ürün katmanları tamamlanacaktır.

Bu dosya ileriye dönük iş ve kabul takibidir; mevcut davranışın kanıtı kaynak ve testlerdir. Faz numaraları mevcut Mxx milestone numaralarını değiştirmez. Özellikle mevcut M78 dağıtım/güncelleme çalışması kendi kapsam ve kabul kayıtlarıyla korunur. Bu dosyanın oluşturulması yeni fazları kendiliğinden uygulama, commit, push veya yayın yetkisi vermez.

## Depo düzeni bakımı — 2026-09-22

- [x] Kullanıcının onayladığı kaynak/test/build ayrımı — 2026-09-22 yerel kabul tamamlandı.
  - Son maddi değişiklikten sonra `pnpm release:check`: **1074 başarılı / 2 atlanan / 0 hata**, toplam 1076; typecheck/build/package PASS. Tam çıktı: `$SCRATCH/dragons-layout-release-check-final.log`.
  - İki deterministik PTY gate'i 10/10 + 10/10; macOS helper lab 14/14, audit-token auth lab 16/16 geçti. Canlı provider/credential veya kurulu uygulama mutasyonu yapılmadı; Windows/Linux native kabulü ve M78 üretim kapıları açık kalır.
  - Dokümantasyon eşlemesi 2026-09-22: kullanıcı isteğiyle `AGENTS.md`, README ve bu yol haritası güncellendi; önceki AGENTS yazma engeli giderildi. Odaklı testler `pnpm build:tests` ardından `.test-build/` içinde çalışır; `dist/` yalnız uygulama JavaScript ve API tip bildirimlerini içerir.
  - 149 kalıcı TypeScript testi `tests/` altındaki alt sistemlere, iki MCP sunucusu `tests/fixtures/` içine, altı TypeScript kabul harness'i `tests/acceptance/` içine taşındı. Altı `.mjs` ve bir PowerShell regresyonu `tests/desktop/`, üç kabul yardımcısı `tests/acceptance/`, PTY fixture'ı `tests/fixtures/` altında korunuyor.
  - Dört C dosyası ve iki shell gate `experiments/macos-native/` altında. Build/package/verification entrypoint'leri korunuyor. `dist/` yalnız uygulama; `.test-build/` ignored test derlemesi. CI/test discovery ve paket dışlama denetimleri yeni yolları kapsıyor.
  - Kapsam yalnız organizasyon ve build/test bağlantılarıdır; ürün davranışı, M78 üretim aktivasyonu ve 2.1 LSP ilerletilmedi. Önceki kabul kayıtlarındaki eski kaynak/build yolları tarihsel kanıttır.

## İnceleme onarım takibi — 2026-09-22

- [x] **13 bulgu için scoped kabul:** Kaynak düzeltmeleri ve yeniden incelemede bulunan OAuth/Desktop yaşam döngüsü açıkları giderildi; son bağımsız inceleme PASS. Doğrulama nihai `pnpm release:check`: 1164 başarılı / 2 atlanan / 0 hata; typecheck/build/package PASS. Git READ koruması otomatik `change-review` yoluna ortak helper ile genişletildi. Slot kapasitesi belgelenmiş **8** değerine indirildi ve literal kapasite regresyonu eklendi. Ayrıntılı 13 maddelik eşleme ve sınırlar: `docs/phase1-acceptance.md` içindeki inceleme düzeltmeleri kaydı.
  - Named slotlar doğrulanmış version-1 OS kaydından explicit seçimle recovery yapar; list inventory ve cooldown süreç-yereldir. Credential cache registry’ye değil yeni model örneğine aittir. Raw/unverified kayda örtülü fallback yoktur.
  - RED kanıtı: otomatik review fsmonitor/clean/process ve 16→8 kapasite için 4 beklenen hata. Odaklı ve son `release:check` logları yerel doğrulama dizininde `dragons-review-integration-focused.log` ve `dragons-review-release-check-final.log`; son kaynak için nihai kanıt `dragons-review-release-final-v2.log`; scoped geliştirme kabulü tamamlandı, yayın/platform kapıları açık.
  - Bu kayıt 1.1–1.5 veya M78 için yeni kabul/yayın iddiası taşımaz. `AGENTS.md` güncel dizinler, komutlar ve güvenlik/yaşam döngüsü sınırlarıyla eşlendi.

## Arayüz kararı: CLI ve Desktop öncelikli

- Şimdilik aktif ürün ve yeni özellik geliştirme yüzeyleri **CLI ve Desktop** olacaktır. Plain CLI ve non-TTY davranışı korunacaktır.
- Hazır bir tam ekran TUI framework'ü ürünün veya runtime'ın zorunlu bağımlılığı olarak gömülmeyecektir. Şu aşamada yeni TUI framework'ü seçilmeyecektir.
- Kullanıcı ileride kendi TUI içeriğini kullanabilir veya farklı bir framework seçebilir. TUI, değiştirilebilir ve isteğe bağlı bir sunum adaptörü olarak kalmalıdır.
- İş kuralları, oturum/provider/auth yaşam döngüsü, araç yetkisi ve iptal runtime/host tarafında kalır. UI framework türleri veya widget durumları çekirdek sözleşmelere taşınmaz.
- CLI ve Desktop ortak, UI'dan bağımsız komut/metadata/event sözleşmelerini kullanır; gelecekteki TUI aynı sözleşmelere bağlanabilmelidir. UI-only geliştirmeler için gereksiz yeni framework soyutlamaları oluşturulmaz.
- Mevcut TUI kaynakları bu kararla silinmez veya devre dışı bırakılmaz; ayrı onay olmadan kaldırılmaz. Yeni TUI özellik geliştirmesi ertelenmiştir. Ortak değişikliklerin mevcut TUI'yi kırmaması için mevcut regresyonlar korunur.
- Yeni fazların kabulünde uygulanabilir CLI/Desktop bağlantısı esas alınır; TUI özellik eşitliği zorunlu değildir. Gelecekte TUI çalışması ayrıca kapsamlandırılır.

## Takip kuralları

- `[ ]`: Henüz kabul edilmedi; başlanmamış, devam eden veya engelli olabilir.
- `[x]`: İlgili kapsam uygulandı, gerekli doğrulamalar tamamlandı ve kanıtı bu dosyaya bağlandı.
- Devam eden maddeye `Durum: Devam ediyor`; engelli maddeye `Durum: Engelli — <neden>` alt notu eklenir. Kabul tamamlanmadan kutu işaretlenmez.
- Tamamlanan her maddenin altına tarih, kapsam/ilgili dosyalar, test veya kabul kanıtı ve varsa açık sınırlar yazılır. Commit yalnız gerçekten varsa belirtilir; credential veya özel kullanıcı verisi kaydedilmez.
- Bir faz ancak kapsamındaki maddeler kabul edildiğinde tamamlanmış sayılır. Kısmi uygulama veya alt test kümesi tam faz kabulü değildir.
- Sıralama öncelik önerisidir. Bağımlılıklar korunarak kullanıcı kararıyla değiştirilebilir. Mevcut işlevler bulunduğu için bu yeni hedefler otomatik olarak tamamlandı sayılmaz.

Kabul kaydı biçimi: `Tamamlanma: YYYY-MM-DD | Kapsam: ... | Kanıt: repo içi test/rapor yolu ve sonuç | Sınırlar: ...`

## Faz 1 — Güvenilirlik ve Çalışma Güvenliği

### Aktif yürütme sırası

Güncel kullanıcı kararı: **geliştirme sürümü kabulü ile üretim yayın kabulü ayrılmıştır**. **1.1–1.5 geliştirme kabulleri, depo düzeni ve inceleme onarımları tamamlandı.** **2.1 LSP Diagnostics** scoped geliştirme kabulü bağımsız inceleme ve gerçek native TypeScript preview sunucusu kanıtıyla tamamlandı. Sıradaki geliştirme **2.2 Inline Context References**; henüz başlanmadı. Mevcut kaynak değişiklikleri ve geçerli kabul kanıtları korunur; başarılı testler gereksiz tekrarlanmaz. Üretim updater/helper, imza/notarization, güvenilir yayın kaynağı ve paketli Windows/Linux/native güncelleme kabulü aşağıdaki **Yayın öncesi kapılar** bölümünde açık tutulur; 1.1 veya sonraki geliştirmeler için önkoşul değildir. Bu kapsam ayrımı kullanıcı onaylıdır; M78 tamamlandı sayılmaz, yayın koşulları kaldırılmaz ve yayın yetkisi verilmez. Ayrıntılı geliştirme checkpoint'leri `docs/phase1-acceptance.md` içindedir.

- [x] **1.1 Geliştirme Sürümü CLI/Desktop Kabulü:** Yerel geliştirme sürümünde temel kullanım, auth iptal/toparlanma, session/provider/model/reasoning ve profil izolasyonu akışlarını doğrulamak; runtime yetkisi, güvenli kapanış ve kaynak kabul kapılarını korumak. İmzalı üretim dağıtımı ve M78 native aktivasyonu bu maddenin dışında, yayın öncesi kapılarda takip edilir.
  - Tamamlanma: 2026-09-18 | Kapsam: kullanıcı onaylı geliştirme kabulü | Kanıt: `docs/cli-desktop-user-acceptance.md` nihai kayıt; bağımsız eşlemede belirlenen son iki kanıt boşluğu native hata→status kontrolü ve son gate ile tamamlandı | Sınırlar: iptal polling’i kontrollü, profil credential binding’i fake; gerçek login/persistence ve tek onaylı istek ayrı tarihsel kanıtlardır. Tam canlı polling, çoklu gerçek hesap ve üretim yayın kabulü iddia edilmez.
  - Doğrulandı: gerçek Electron provider/model önerileri, yeni session/resume, exact özel model ID, reasoning Apply/yeniden açılış kalıcılığı ve temiz kapanış. Kullanıcı Desktop ChatGPT login → OAuth iptal/toparlanma → restart kalıcılığı → logout/not signed in akışını doğruladı. Kanıt: `docs/cli-desktop-user-acceptance.md`. Bu adımlar tekrar istenmez; CLI ve diğer auth türlerine genellenmez.
  - Son doğrulanmış kaynak gate'i: 1009 kayıt, **1007 başarılı, 2 atlanan, 0 hata**; typecheck/build/package geçti. Log: `/tmp/dragons-phase1-development-acceptance-gate.log`; bağımsız kapsamlı olmayan onarım incelemeleri `docs/m78-secure-auto-update.md` içinde. Bu belge değişikliği yeni kaynak gate'i gerektirmez.
  - Aşağıdaki M78 checkpoint'leri tarihsel referanstır; açık yayın koşulları 1.1'i engellemez.
  - Native helper checkpoint: doğrulama `sh experiments/macos-native/test-macos-native-helper.sh` ile 14/14 gerçek macOS testi doğruladı; uygulamadan bağımsız C helper host-exit gözlemliyor, kurulum yetkisi vermiyor ve paketlenmiyor. Öncesindeki lifecycle/preflight kaynak gate'i: 830 başarılı, 2 Linux atlaması; typecheck/build/package geçti. İmzalı helper dağıtımı, güçlü OS peer identity, gerçek veri sandbox'ı ve üretim lifecycle bağlantısı açık. Laboratuvar ilerlemesi M78 kabulü değildir.
  - Son macOS staging artımı: gerçek ZIP32/plist çözümleme, güvenli framework symlink ve executable mode doğrulaması eklendi. Doğrulama `release:check`: 807 test, 805 başarılı, 2 Linux atlaması; typecheck/build/package başarılı (`/tmp/dragons-m78-macos-staging-gate.log`). Native kurulum/aktivasyon, helper devri ve gerçek veri bariyeri açık; platform kabulüyle karıştırılmamalı. Önceki sayılar tarihsel checkpoint'lerdir.
  - Güncel M78 geliştirme checkpoint'i (2026-09-11): Desktop update status/check/cancel bağlantısı ve host-only imzalı metadata kontrolü uygulandı; üretim kapalı, indirme/kurulum bağlı değil. macOS doğrulama alt kümesi fixture testli; gerçek Electron bundle/aktivasyon desteği değildir. Son `pnpm release:check`: 777 test, 775 geçti, 2 Linux testi atlandı, 0 hata; typecheck/build/package geçti (`/tmp/dragons-m78-desktop-check.log`). Önceki gate sayıları tarihsel kanıttır. Windows/Linux gerçek testleri kullanıcı kararıyla toplu kabul için ertelendi; geliştirme ve kabul ayrı tutulur. Biriken matris: `docs/m78-secure-auto-update.md`.
  - [x] İzole CLI config/workspace/profili ve güncel kaynak derlemesi. Tamamlanma: 2026-09-10 | Kanıt: `docs/cli-desktop-user-acceptance.md`, `pnpm build` başarılı ve gerçek PTY açılışı; macOS HOME değişikliğinin Keychain'i bozduğu ayrıştırılıp host configPath izolasyonuna geçildi | Sınırlar: credential kalıcılığı ve profil geçişi henüz doğrulanmadı.
  - [x] CLI maskeli girişte credential girmeden Escape ile iptal ve ardından `/status` çalıştırma. Tamamlanma: 2026-09-10 | Kanıt: `docs/cli-desktop-user-acceptance.md`, gerçek PTY | Sınırlar: yalnız boş API-key girişi; OAuth iptali veya Desktop kabulü değildir.
  - [x] CLI `/` / provider seçim hatası (CLI-01), regresyonu ve gerçek terminal yeniden doğrulaması.
    - Durum: Doğrulandı — CLI line-input ve resize düzeltmeleri uygulandı; ilgili 74/74 test doğrulandı. Ağ kapalı OS PTY menü/ok/Tab/ayrı Enter/yerel komut/çıkış ve native Terminal kısa `/login ` menüsünde 148→55→148 kontrolü geçti. Uzun sarılmış girişin native görsel alt kabulü 2026-09-17'de doğrulandı: orta ekleme/silme ve 80→55→100 sütun resize; daraltma sonrası `limRa12` ve genişletme sonrası `lima12`/`zulu26` ekranlarını ayrıca incelendi. Kanıt: `docs/cli-desktop-user-acceptance.md:18–25`. Kaynak değişmedi; mevcut testler tekrarlanmadı. OAuth/Desktop ve 1.1 bütünü bu alt kabulden ayrı kalır.
  - [x] CLI auth-error recovery / OAuth cancellation (CLI-02/CLI-03) gerçek terminal kabulü. 2026-09-10: dört regresyon RED → GREEN, ilgili CLI/OAuth/storage testleri 65/65 geçti; son native hata/toparlanma ve sınırlı iptal kanıtı aşağıdadır. Kanıt: `docs/cli-desktop-user-acceptance.md`.
    - Durum: Kısmi doğrulandı — native Terminal'de ağ kapalı `/login chatgpt` hatası ve composer dönüşü önceki kanıttır. Son native kontrolde gerçek device initiation HTTP 200 sonrası bekleyiş → Ctrl+C → `/status` → `/exit` geçti; iptal ve status ekranını ayrıca incelendi. Challenge çıktı öncesi maskelendi, polling yerelde abort'a kadar tutuldu; token exchange veya credential erişimi yapılmadı. Kanıt: `docs/cli-desktop-user-acceptance.md`. Ek native hata kontrolünde enjekte ağ hatası → composer → `/status` → `/exit` geçti; ekranı ve sıfır credential/inference sayaçlarını doğrulandı. Kanıt kökü: `/private/tmp/dragons-cli-auth-error-3b6d8bda-8827-4462-bd3b-ecd693e0d8b7/`. Tam canlı polling veya canlı provider reddi iddia edilmez.
    - Profil/state izolasyonu: doğrulama build + `dist/profile-composition-isolation.test.js` ile üç ayrı süreçte A→B→A CLI/Desktop config/session ve credential namespace izolasyonunu doğruladı. Native binding fake olduğundan bu kod izolasyonu kanıtıdır; gerçek çoklu hesap kabulü değildir.
  - [x] CLI login → restart → auth → model → reasoning → onaylı kısa istek → logout ve profil izolasyonu. Birleşik geliştirme kanıtı: aşağıdaki gerçek login/PTY kalıcılık ve non-TTY onaylı istek + ayrı A→B→A kompozisyon izolasyonu. Tek kesintisiz native senaryo veya gerçek çoklu hesap testi değildir.
    - [x] ChatGPT kullanıcı girişi ve yeni süreç/gerçek PTY üzerinden `signed in` + `macOS Keychain` doğrulaması. Tamamlanma: 2026-09-10 | Kanıt: `docs/cli-desktop-user-acceptance.md` | Sınırlar: canlı istek/logout ve profil geçişi açık; provider değişiminde eski model durum etiketi CLI-04 olarak kaydedildi.
    - [x] Kullanıcı onaylı tek canlı ChatGPT isteği ve kabul hesabından logout. Tamamlanma: 2026-09-10 | Kanıt: `docs/cli-desktop-user-acceptance.md`, tek ağ isteği/HTTP 200/beklenen kısa metin eşleşmesi; yeni süreçte reasoning `low`; logout sonrası ayrı süreçte `not signed in / macOS Keychain` | Sınırlar: non-TTY tek-seferlik CLI test host yolu; tam etkileşimli akış, profil geçişi ve Desktop açık.
  - [x] CLI sonrasında gerçek Electron kullanıcı akışı ve maskeli pencere yaşam döngüsü. Kanıt: provider/model/session/reasoning native matrisi, kullanıcı OAuth restart/logout ve boş modal Escape/Cancel→status; `docs/cli-desktop-user-acceptance.md`. macOS sheet bağımsız X sunmaz; parent-close/crash kapsamı otomatik testtir.
  - [x] CLI-04 güncel model etiketi: model/provider değişiminden sonra durum satırı gerçek Node CLI + OS PTY üzerinde doğrulandı; kabul hesabı logout durumunda kaldı. Kanıt: `docs/cli-desktop-user-acceptance.md` | Sınır: görsel terminal-emülatör kontrolü ve CLI-01 ayrı kabul gerektirir.
  - [x] Profil reasoning kalıcılığı/izolasyonu: ayrı geçici config kökünde A(low) → B(default, sonra high) → A(low), her seçimden sonra yeni CLI süreciyle OS PTY üzerinden doğrulandı. Kanıt: `docs/cli-desktop-user-acceptance.md` | Sınır: ağ kapalı; credential ve tüm state türleri için tam izolasyon kabulü değildir.
  - [x] Son değişiklik için `release:check` ve nihai kabul kaydı; M78 dağıtım/güncelleme kabulü ayrıca açık kalır.
    - Tarihsel gate (son geçerli gate yukarıdadır): `pnpm release:check` başarılı — 705 test, 703 geçti, 2 atlandı, 0 hata; typecheck/build/package doğrulaması geçti. `package.json` test komutuna `dist/cli/*.test.js` eklendi; önceden CLI alt dizinindeki regresyonlar genel gate dışında kalıyordu. Kanıt: `docs/cli-desktop-user-acceptance.md`. Bu sonuç native/Desktop veya M78 kabulü değildir.
    - M78'in açık aktivasyon, güvenilen kaynak ve platform koşulları aşağıdaki yayın öncesi kapılara taşındı; 1.1'in geliştirme kabulü için önkoşul değildir. Üretim yayını öncesinde tamamlanmaları zorunludur.
- [x] **1.2 Checkpoint ve Rollback:** Dosya değişiklikleri için otomatik snapshot, diff inceleme, seçmeli geri yükleme ve `/rollback` sağlamak.
  - Tamamlanma: 2026-09-18 | Kapsam: desteklenen normal geliştirme workspace'inde onaylı built-in dosya WRITE işlemleri; yeni dosya/silme/mevcut alt dizinlerde düzenleme, sayfalı diff ve exact JSON-quoted dosya seçimiyle CLI/Desktop rollback | Kanıt: `docs/phase1-acceptance.md`; son `release:check` 1060 kayıt / 1058 başarılı / 2 atlanan / 0 hata, typecheck/build/package PASS (`/tmp/dragons-phase1-checkpoint-final-gate.log`); son inode-zinciri onarımı bağımsız incelemesinde PASS.
  - Sınırlar: kullanıcı onaylı normal-workspace eşzamanlılık modeli; gözlemlenebilir dış değişiklikte çatışma, düşmanca kontrol–syscall yarışı için atomik garanti yok. Snapshot yalnız süreç/session belleğinde, görüntü başına 256 KiB; işlem ve geçmiş 2 MiB, geçmiş 32 checkpoint. Credential dışlama politikası evrensel secret detector değildir. Eksik dizin oluşturulmaz; O_NOFOLLOW olmayan platformda structural backend kapalıdır. Native Windows/Linux kabulü yayın kapısında açık; bu kayıt tüm platformlarda çalışma iddiası değildir. EXECUTE/MCP yan etkileri kapsam dışıdır.
  - WRITE ret/iptal, symlink/hardlink/topoloji ve dış içerik çatışmaları, kısmi hata/uncertain yollar, silme sonrası yeni inode ile önceki checkpoint zinciri, session izolasyonu ve non-persistence regresyonları doğrulandı. `/clear` konuşmayı temizler, aynı-session checkpoint geçmişini korur; `/new`/`resume` ve süreç yaşam döngüsü sınırları belgelenmiştir.
- [x] **1.3 Provider Fallback:** Geçici hata veya kullanılamazlıkta tanımlı yedek provider/model zincirine kontrollü geçmek.
  - Kabul hedefi (2026-09-22): varsayılan kapalı ve açık `allow-context-sharing` onaylı, en çok üç exact kayıtlı provider/model hedefi; yalnız typed pre-stream HTTP 408/409/425/429/5xx hatasında ilk yanıt/stream/araç yürütmesi öncesi tek geçiş zinciri. Auth, entitlement, protocol/unknown hata ve her tür iptal fail-closed kalır.
  - Kimlik hedefi: hedef provider/model, hedef isteğinden önce atomik olarak aynı foreground session'a kaydedilir; continuation yalnız hedeften gelir. `runAgent()` yeniden başlamaz; mevcut tool çıktıları ile WRITE/EXECUTE tekrar edilmez. Child/background fabrikaları kimlik benimseme yetkisi almadan fallback yapmaz.
  - Yüzey hedefi: CLI, runtime ve Desktop host aynı profile config'ini kullanır; görünür geçiş ile diagnostics yalnız güvenli başlangıç/hedef kimliklerini gösterir, prompt/bağlam/credential içermez. Desktop profile izolasyonu ve 1.2 normal-workspace/platform sınırları değişmez.
  - Kanıt hedefi: registry/config, runtime persistence–resume–iptal, CLI interactive/plain ve Desktop host profile izolasyonu deterministik injected adapter testleri; son maddi değişiklikte `pnpm release:check`. Canlı provider ve Windows/Linux native kabulü bu geliştirme kabulünün parçası değildir.
  - Tamamlanma: 2026-09-22 | Kanıt: `docs/phase1-acceptance.md`; `pnpm release:check` ile 1062 kayıt / 1060 başarılı / 2 atlanan / 0 hata, typecheck/build/package PASS doğrulandı. Görünür diagnostics yalnız bounded güvenli kimlik geçmişini gösterir; `tests/core/diagnostics.test.ts` bu formatter yolunu kapsar. M78 ve gerçek Windows/Linux kabulü yayın öncesi kapılarda açık kalır.
- [x] **1.4 Credential Pools:** Provider başına çoklu credential; rate-limit, sağlık ve cooldown durumuna göre güvenli seçim yapmak.
  - Tamamlanma: 2026-09-22 | Kapsam: API-key provider başına en fazla 8 isimli slot; secret yalnız OS credential store’da, config’de yalnız doğrulanmış `apiKeySlots` referansı. TUI ve yerel Desktop maskeli ekleme, güvenli listeleme ve silme sağlar; uzak Desktop credential yönetimini açmaz.
  - Çalışma: Registry seçim kopyasını saklar; her yeni model örneği ilk credential çözümünü kendi auth facade’ına pinler; eksik, unverified veya cooldown’daki slot yeni run için fail-closed olur. 429 `Retry-After` veya varsayılan 30 saniye, en fazla 5 dakika süreç-yerel cooldown uygular; devam eden pinli run başka slota geçmez. Cooldown/health telemetrisi config, session veya OS secret store’a yazılmaz. OS slot kaydı yalnız secret ve restart recovery için sürümlü doğrulama durumunu taşır; açık slot seçimi doğrulanmış kaydı kurtarabilir. Listeleme OS kayıtlarını keşfetmez ve secret okumaz.
  - Kanıt: `tests/provider/api-key-auth.test.ts`, `tests/provider/api-key-pool.test.ts`, `tests/core/config-model-id.test.ts`, `tests/desktop/desktop-slash.test.ts`, `tests/desktop/desktop-host-isolation.test.ts`, `tests/tui/tui-api-key.test.ts`; `pnpm release:check` ile **1064 başarılı / 2 atlanan / 0 hata**, toplam 1066; typecheck/build/package PASS.
  - Sınırlar: Local provider ve ChatGPT OAuth çoklu hesap/refresh kapsam dışındadır. Canlı provider, native OS credential-store ve Windows/Linux kullanıcı kabulü iddia edilmez.
- [x] **1.5 Genişletilmiş Provider Yönetimi:** Yeni adaptörler, routing seçenekleri ve model/reasoning yeteneklerini doğrulanmış metadata ile yönetmek.
  - Tamamlanma: 2026-09-22 | Kapsam: ortak trusted TUI/Desktop `/provider` public metadata görünümü, güvenli named API-key pool listesi, exact/custom model ve verified reasoning sınırları, DTO/stale/busy regresyonları | Kanıt: `docs/phase1-acceptance.md`; `pnpm release:check` ile **1067 başarılı / 2 atlanan / 0 hata**, toplam 1069; typecheck/build/package PASS | Sınırlar: yeni adapter, canlı discovery/entitlement/credential doğrulaması ve Windows/Linux native kullanıcı kabulü eklenmedi.

## Yayın öncesi kapılar — geliştirme fazlarından ayrı

Bu bölüm geliştirme fazı değildir. Açık maddeler 1.1–1.5 ürün geliştirmesini durdurmaz; ilgili üretim yayınının kabulünü engeller. M78 koşulları silinmedi veya geçmiş sayılmadı. Kaynak ve ayrıntılı kanıt: `docs/m78-secure-auto-update.md`; platform kullanıcı kabulü: `docs/cli-desktop-user-acceptance.md`.

- [ ] **M78 native aktivasyon ve kurtarma:** paketlenmiş helper, güvenilir handoff/süreç sahipliği, gerçek kurulum–yeniden başlatma, kesinti sonrası recovery ve kullanıcı verisi erişim bariyeri. Mevcut staging/preflight ve laboratuvarlar tam kabul değildir; `canInstall:false` korunur.
- [ ] **Üretim imza ve güven kaynağı:** kontrollü HTTPS yayın kaynağı, sabitlenmiş imza kimliği/anahtarı, rotation/revocation ve freshness/anti-rollback politikası; macOS Developer ID/notarization ve Windows imza politikası. Erişim/yayın yetkileri ayrıca alınır.
- [ ] **Gerçek platform/paket kabulü:** macOS arm64, Windows x64 ve Linux x64 üzerinde son tanımlı artifact ile kurulum, güncelleme, yeniden açılış, iptal/kesinti/kurtarma ve sonraki güncelleme. Windows/Linux kuyruğu korunur; deterministik testler veya önceki temel Windows denemesi bu kabulün yerine geçmez. DEB paket yöneticisi sınırı korunur.
- [ ] **Nihai yayın güvenlik incelemesi ve gate:** son maddi kaynakta ilgili native kanıtlar, bağımsız inceleme, `release:check` ve nihai M78 kabul kaydı. Geliştirme gate'inin geçmesi yayın izni değildir.

## Faz 2 — Geliştirici Deneyimi ve Bağlam

- [x] **2.1 LSP Diagnostics — scoped geliştirme kabulü tamamlandı (2026-09-23):** Açık stdio yapılandırması, write/edit/patch sonrası ayrı EXECUTE onayı, command/args/document sunumu ve CLI/Desktop tanı iletimi uygulandı. Bağımsız inceleme PASS; nihai `pnpm release:check`: **1201 başarılı, 2 atlanan, 0 hata**; typecheck/build/package başarılı. Gerçek Microsoft TypeScript native preview `7.0.0-dev.20260707.2`, macOS arm64 sentetik workspace üzerinde FULL TS2322 → düzeltme → boş tanıyı production model devamına iletti. Varsayılan kapalı/EXECUTE ret durumunda sıfır spawn doğrulandı. TLS 5.0.0 sürümsüz push desteklenmez; stable/default server, elle GUI/PTY ve diğer kurulu platform kabulleri iddia edilmez. Kanıt: `docs/lsp-diagnostics-acceptance.md`. M78 yayın kapıları açık; 2.2 başlamadı.
- [ ] **2.2 Inline Context References:** `@file`, `@folder`, `@diff` ve `@url` benzeri referanslarla içeriği mesaja eklemek.
- [ ] **2.3 Session Search:** Konuşma ve araç geçmişinde indeksli arama; agent'ın ilgili oturumu bulup okuyabilmesini sağlamak.
- [ ] **2.4 Worktree Yönetimi:** Oturum içinden izole Git worktree oluşturmak, seçmek ve workspace'i kontrollü değiştirmek.
- [ ] **2.5 Dinamik Tool Search:** Büyük araç kataloglarında arama ve yalnız gerektiğinde şema yükleme sağlamak.
- [ ] **2.6 Programatik Araç Çalıştırma:** İzole kod oturumundan araçları mevcut yetki sınırları üzerinden çağırmak; döngü, filtreleme ve toplu sonuç işlemek.

## Faz 3 — Genişletilebilirlik ve Öğrenme

- [ ] **3.1 Plugin SDK:** Manifest, keşif, kayıt, sürüm uyumluluğu ve capability/onay sözleşmeleriyle plugin altyapısı kurmak.
- [ ] **3.2 Lifecycle Hooks:** Oturum, tur, araç ve dosya olaylarına kullanıcı tanımlı işlemler bağlamak.
- [ ] **3.3 Plugin Kataloğu:** İncelenmiş, sürümü sabitlenmiş plugin'leri keşfetmek, kurmak, güncellemek ve kaldırmak.
- [ ] **3.4 Skills Hub:** Skill paketlerini ve kaynak kayıtlarını keşif, kurulum ve güncelleme yaşam döngüsüyle yönetmek.
- [ ] **3.5 Skill Yönetim Araçları:** Skill oluşturma, düzenleme, doğrulama, arşivleme ve silme için özel araçlar sağlamak.
- [ ] **3.6 Skill Curator:** Kullanım/eskime takibi yapmak; bakım, birleştirme ve arşivleme önerileri üretmek.
- [ ] **3.7 Haricî Memory Provider'ları:** Yerel memory sözleşmesinden haricî servislere açık paylaşım, senkronizasyon ve saklama politikalarıyla bağlanmak.

## Faz 4 — Kalıcı Otomasyon ve Çoklu Agent

- [ ] **4.1 Cron Zamanlayıcısı:** Tek seferlik/tekrarlayan görevler, duraklatma, devam, elle tetikleme ve skill bağlama sağlamak.
- [ ] **4.2 Loop ve Heartbeat:** Oturum içi tekrarlayan prompt'lar ve boşta çalışan bağlamı koruyan kontroller eklemek.
- [ ] **4.3 Persistent Goals:** Tamamlanma değerlendirmesi, bütçe ve durdurma koşullarıyla hedef üzerinde turlar boyunca çalışmak.
- [ ] **4.4 Profiller Arası Kanban:** Görev, bağımlılık, atama ve ilerlemeyi ortak kalıcı panoda yönetmek.
- [ ] **4.5 Worker Lanes ve Handoff:** Ayrı worker süreçleri, görev sahipliği, kurtarma ve güvenilir profiller arası devir sağlamak.
- [ ] **4.6 Mixture of Agents:** Çoklu model sonuçlarını aggregator ile birleştirmek; seçilebilir MoA preset'leri sunmak.
- [ ] **4.7 Batch Processing:** Bağımsız agent çalışmalarını kuyruk, checkpoint, bütçe ve sonuç kaydıyla toplu yürütmek.

## Faz 5 — İzole Çalıştırma Ortamları

- [ ] **5.1 Execution Backend Sözleşmesi:** Yerel/uzak çalıştırmayı ortak yaşam döngüsü, iptal, çıktı sınırı ve yetkilendirme altında toplamak.
- [ ] **5.2 Docker Backend:** Kontrollü dosya erişimi ve kaynak sınırlarıyla container içinde görev çalıştırmak.
- [ ] **5.3 SSH Backend:** Uzak çalışma, bağlantı yaşam döngüsü, workspace eşlemesi ve kimlik doğrulama sınırları sağlamak.
- [ ] **5.4 Cloud ve HPC Backend'leri:** İhtiyaca göre Daytona, Modal ve Singularity benzeri ortamlar için ayrı adaptörler geliştirmek.
- [ ] **5.5 Egress ve Credential Injection:** İzole ortama gerçek credential taşımadan host üzerinden yetkilendirilmiş dış servis erişimi sağlamak.

## Faz 6 — Web ve Bilgisayar Kullanımı

- [ ] **6.1 Web Search ve Extract:** Çoklu backend üzerinden web araması ve URL'den temiz, kaynaklandırılabilir içerik çıkarımı sağlamak.
- [ ] **6.2 Browser Automation:** Yerel CDP ve uygun cloud browser seçenekleriyle gezinme, okuma, form ve screenshot akışları sağlamak.
- [ ] **6.3 Computer Use:** Pencere, ekran ve accessibility verisi üzerinden kullanıcı yetkisiyle kontrollü masaüstü etkileşimi sağlamak.
- [ ] **6.4 Uzmanlaşmış Arama Entegrasyonları:** X/Twitter gibi servisler için provider'a özgü arama adaptörleri eklemek.

## Faz 7 — Belgeler, Multimodal ve Teslimatlar

- [ ] **7.1 Belge Çıkarımı:** PDF, Office, notebook, OpenDocument ve EPUB'u okunabilir metne dönüştürmek.
- [ ] **7.2 OCR Akışı:** Taranmış belgeyi tespit etmek, gerektiğinde OCR uygulamak ve kalite sınırlarını göstermek.
- [ ] **7.3 Görsel Girdi ve Analiz:** Pano/dosyadan görsel eklemek ve desteklenen modellere güvenli aktarmak.
- [ ] **7.4 Görsel Üretimi:** Provider bağımsız sözleşme ve isteğe bağlı üretim adaptörleri sağlamak.
- [ ] **7.5 Artifact Teslimi:** Dosyaları attachment, indirme kartı ve uygun preview ile sunmak.
- [ ] **7.6 Sesli Kullanım:** Transkripsiyon, TTS ve mikrofon; ardından gerçek zamanlı voice mode ve isteğe bağlı wake-word eklemek.

## Faz 8 — Desktop Çalışma Alanı ve Web Dashboard

- [ ] **8.1 Çok Panelli Desktop:** Sohbet, araç çıktısı ve içeriği sekme/pane düzeninde kullanmak.
- [ ] **8.2 Preview ve Dosya Gezgini:** Web/dosya/artifact preview, dosya gezgini, attachment ve drag-drop sağlamak.
- [ ] **8.3 Gömülü Terminal ve Git Review:** Süreçleri uygulamada izlemek; diff, değişiklik ve worktree yönetmek. Desktop terminali, zorunlu tam ekran TUI framework'ü anlamına gelmez.
- [ ] **8.4 Yönetim Panelleri:** Provider, profile, session, memory, skills, MCP ve otomasyon için görsel yönetim sunmak.
- [ ] **8.5 Web Dashboard:** Yönetim yeteneklerine kimlik doğrulamalı tarayıcı arayüzünden erişmek.
- [ ] **8.6 Çoklu Instance Yönetimi:** Birden fazla yerel/uzak Dragons instance'ını tek arayüzden yönetmek.
- [ ] **8.7 UI Genişletmeleri:** Plugin'ler için kontrollü panel, slot, tema ve layout noktaları sağlamak; çekirdeği UI framework'ünden bağımsız tutmak.

## Faz 9 — Mesajlaşma ve Olay Entegrasyonları

- [ ] **9.1 Messaging Gateway Çekirdeği:** Platform/kanal/kullanıcı oturum yönlendirmesi, pairing, erişim kontrolü, teslim ve yeniden bağlantı sağlamak.
- [ ] **9.2 İlk Platform Adaptörleri:** Telegram, Discord ve Slack ile gateway sözleşmesini doğrulamak.
- [ ] **9.3 Genişletilmiş Platformlar:** WhatsApp, Signal, e-posta, SMS, Matrix, Teams ve diğer platformları ayrı adaptörler olarak eklemek.
- [ ] **9.4 Webhook Tetikleyicileri:** GitHub, GitLab ve diğer doğrulanmış dış olaylarla görev başlatmak.
- [ ] **9.5 İş Akışı Entegrasyonları:** Microsoft Graph, toplantılar, Google Workspace ve Home Assistant gibi alanlara özel bağlantılar sağlamak.
- [ ] **9.6 Çoklu Gateway ve Relay:** Bağımsız profil gateway'leri ve credential sahipliğini ayıran relay bağlantıları sağlamak.

## Faz 10 — Standart API ve Agent Birlikte Çalışabilirliği

- [ ] **10.1 OpenAI Uyumlu API:** Runtime'ı uyumlu haricî frontend'lere standart API ile sunmak.
- [ ] **10.2 Open WebUI Entegrasyonu:** Standart API üzerinde hazır bağlantı ve doğrulanmış kullanım sağlamak.
- [ ] **10.3 ACP Desteği:** ACP uyumlu editör ve istemcilerden oturumlara erişmek.
- [ ] **10.4 A2A Desteği:** Agent keşfi, yetenek bildirimi ve sınırlandırılmış agent iletişimi sağlamak.
- [ ] **10.5 Subscription Proxy:** Yalnız provider'ın izin verdiği kullanım koşullarında desteklenen abonelikleri kontrollü endpoint olarak sunmak.

## Faz 11 — Profiller, Botlar ve Taşınabilirlik

- [ ] **11.1 Profil Yaşam Döngüsü:** Config-only/tam clone, export/import ve güvenli taşıma sağlamak.
- [ ] **11.2 Agent Distributions:** Credential'ları hariç tutarak Git/paket üzerinden paylaşılabilir profil kurmak ve güncellemek.
- [ ] **11.3 Diğer Ajanlardan Import:** Claude Code/Codex instructions, skills, MCP ve izin ayarlarını önizlemeli dönüştürmek.
- [ ] **11.4 Bot Mode:** İsim, rol ve avatar taşıyan botlar; bot başına bağımsız profil ve rutinler sunmak.
- [ ] **11.5 Bot İletişimi:** Bot grup sohbetleri, doğrudan mesajlaşma ve instance'lar arası yönlendirme sağlamak.
- [ ] **11.6 Persona ve Temalar:** Persona dosyaları, CLI skin'leri ve kullanıcı tema ayarları sağlamak; gelecekteki TUI framework'üne bağlanmamak.
- [ ] **11.7 Opsiyonel Görsel Kişiselleştirme:** Mascot/pet gibi çekirdekten bağımsız arayüz eklentileri sunmak.

## Faz 12 — Kurumsal Yönetim ve Dağıtım

- [ ] **12.1 Managed Configuration:** Yönetici tarafından sabitlenen ayarlar, açık öncelik kuralları ve görünürlük sağlamak.
- [ ] **12.2 Haricî Secret Sources:** 1Password, Bitwarden ve command-helper adaptörleri; kaynak önceliği ve provenance yönetmek.
- [ ] **12.3 Yönetim ve Denetim Görünürlüğü:** Config değişimleri, görevler ve yetkilendirme kararları için credential içermeyen denetim kayıtları sağlamak.
- [ ] **12.4 Dağıtım Seçeneklerinin Genişletilmesi:** Talebe göre deklaratif kurulum ve ek çalışma ortamları eklemek.

## Ortak tamamlanma ölçütleri

1. İlgili özellik uçtan uca uygulanır; uygulanabilir CLI/Desktop/API bağlantıları tamamlanır. TUI geliştirmesi bu yol haritasının mevcut kabul zorunluluğu değildir.
2. Runtime yetkisi, workspace/profil izolasyonu, iptal, veri sınırları ve hata yolları korunur.
3. Etkilenen deterministik regresyonlar ve gerekli entegrasyon testleri geçer.
4. Provider, donanım veya native platform gerektiren kabul ayrı kaydedilir. Deterministik test canlı kabul diye sunulmaz. Gerekli canlı kabul eksikse ilgili madde açık kalır.
5. Desteklenen davranış ve gerçek sınırlar dokümante edilir.
6. Değişiklik etkisine uygun kontroller ve AGENTS.md'deki kabul kapıları uygulanır. Salt doküman değişikliği gereksiz tam test koşusu gerektirmez.
7. Bu dosyadaki ilgili kutu kanıt kaydıyla birlikte işaretlenir. Tamamlandı, commit edildi ve yayımlandı durumları birbirine karıştırılmaz.
