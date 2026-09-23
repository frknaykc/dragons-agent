# 1.1 CLI / Desktop — geliştirme kabulü tamamlandı

## Nihai geliştirme kabulü — 2026-09-18

Kullanıcı onaylı kapsam ayrımı uyarınca ROADMAP 1.1 geliştirme kabulü kapatıldı. Aşağıdaki tarihsel açık/engelli kayıtlar sonraki kanıtlarla birlikte okunur; üretim M78 ve platform yayın kapıları ayrı ve açıktır.

Bağımsız eşleme `deleg_60a52823/task-0`, ürün engeli saptamadı; native auth hata sonrası yerel komut ve son gate kaydını eksik buldu. İkisi ana ajan tarafından tamamlandı: gerçek Terminal'de enjekte ağ hatası → composer → `/status` → `/exit`; ekran ve `counts.json` ayrıca incelendi. Kanıt kökü `/private/tmp/dragons-cli-auth-error-3b6d8bda-8827-4462-bd3b-ecd693e0d8b7/`; gerçek HTTP, credential ve inference yok. Bu canlı provider reddi değildir.

Son kaynak `pnpm release:check`: 1009 kayıt, 1007 başarılı, 2 atlanan, 0 hata; typecheck/build/package PASS. Log `/tmp/dragons-phase1-development-acceptance-gate.log`. Sonraki salt-okunur kabul incelemesi nedeniyle gate tekrarlanmadı. Ayrıca ana ajan `profile-composition-isolation.test.js` ile üç süreçte A→B→A gerçek CLI/Desktop config/session ayrımı ve fake native binding altında namespace/logout sınırlarını doğruladı.

Kapanış birleşik kanıtlara dayanır: native CLI menü/resize/düzenleme ve hata/iptal toparlanması, tarihsel gerçek login/PTY kalıcılığı ve onaylı non-TTY tek istek, native Desktop seçim/session/reasoning kontrolleri, kullanıcı OAuth ve Cancel/status kabulü. Tam canlı OAuth polling, tek kesintisiz native CLI giriş→model akışı veya çoklu gerçek hesap izolasyonu iddia edilmez. Bu sınırlar üretim kabulüne yükseltilmez; yeni login veya canlı istek gerekmedi.

## Tarihsel kayıtlar

Tarih: 2026-09-10. Kaynak: `main`, başlangıç HEAD `c18cd9d`; kabul, mevcut değiştirilmiş çalışma ağacından derlenen kaynak üzerindedir, temiz commit kabulü değildir. TUI dosyalarına bu kabul çalışmasında dokunulmadı. M78 ve 1.1 bütünü açık kalır.

## 2026-09-17 — macOS boş API-key prompt ek yerel kabulü (kısmi)

- Önceki kabul senaryoları tekrarlanmadı; gerçek Electron host + üretim `createDesktopSecretPrompt` ile yalnız `/login openai-api` boş istemi çalıştırıldı. Gerçek HOME korundu; kurulu uygulama ve kişisel pencere içerikleri kullanılmadı. Disposable profil: `acceptance-44c1f960-1f57-4186-984f-efcfe4cc8453`; launcher/config/userData kökü: `/var/folders/h3/lvl9_1sx3n156z1_fssb94x40000gn/T/dragons-mask-native-rplsw5sr/`.
- **PASS:** boş modal açıldı; native Escape sonrasında `API-key sign-in cancelled.` ve `No session` görüldü. Ardından gerçek yerel `/status` döndü (`contextCharacters: 0`, `recentDiagnostics: []`); aynı istem yeniden açıldı, busy/pending kilidi kalmadı. Hiçbir credential girilmedi; `Save key` kullanılmadı.
- **Açık/native araç sınırı:** macOS modal bir AXSheet olarak görünüyor; bağımsız X düğmesi sunulmuyor. Cancel düğmesi AX ağacında bulundu fakat background hedef doğrulaması reddedildi; pixel/foreground denemeleri kapanışı doğrulamadı. İkinci Escape de exact-window focus hatası verdi. Bu nedenle **Cancel ve X kullanıcı etkileşimi PASS değildir**; X bu sheet sunumunda N/A, diğer platform pencere kapatma kabulü çıkarılamaz. İkinci prompt yalnız sahip olunan PID 76569'a SIGTERM ile host cleanup sırasında kapandı; bu native Cancel kanıtı değildir. PID'nin çıktığı doğrulandı.
- Yapısal sayaçlar (`counts-76569.json`): `promptOpened=2`, `promptClosed=2`, `secretNonempty=0`, `fetch=0`, `native=0`, `inference=0`, `auth=0`; disposable kökte `auth.json=0`, session JSONL=0. Network/native credential/inference/auth mutation yolları launcher'da fail-closed; loginApiKey kaydetme callback'i kapalı, yalnız blank requestSecret akışı gerçek bırakıldı. Sayaçlar genel OS ağ denetimi iddiası değildir.
- Native ekran kanıtları (aktif Hermes profilinin `cache/images/` dizini): `computer_use_554d66a1c55d4ac4a0ff6e941dc6f377.png` (Escape sonrası), `computer_use_8a3d1df8c3014e82af6608f5e120f7b9.png` (yerel status), `computer_use_b4dcc44fd5924361944c57e5484be9d6.png` (yeniden açılmış boş modal), `computer_use_3f05d15555534f388c72a7c52cc954aa.png` (Cancel denemesi sonrası halen açık). Modal açıklaması/API-key etiketi görsel olarak üst üste geliyor; bu turda üretim kodu değiştirilmedi.
- Sınır: gerçek anahtar kaydetme, credential erişimi, ChatGPT kullanıcı kabulü, inference, updater/signing/release çalıştırılmadı. Bu ek kanıt 1.1 bütününü kapatmaz; native Cancel teslimi eksik kalır.

## 2026-09-17 — Native CLI OAuth wait → Ctrl+C → status → exit (sınırlı canlı kabul)

- **PASS, yalnız yerel iptal/toparlanma:** gerçek macOS Terminal penceresi `4367`, mevcut `dist/cli.js` `main()` ve gerçek `createChatGPTAuthService()` kullanıldı. `/login chatgpt` gerçek device-initiation endpoint'inden HTTP 200 aldı; `Waiting for authentication...` görüldü. Native foreground Ctrl+C ardından `chatgpt: authentication cancelled.`, yeni composer, `/status` yanıtı (local provider ve izole workspace) ve `/exit` → `ACCEPTANCE_EXIT_OK` / shell dönüşü ekranla doğrulandı. Background klavye aynı PID'deki diğer pencere nedeniyle reddedildi; foreground teslimine geçildi.
- **Kesin ağ sınırı:** yalnız bir `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, redirect kapalı ve 15 saniye timeout. Gerçek device challenge üretildi fakat `Code:` çıktısı stdout/transcript/ekran yakalamasından **önce** `[MASKED BEFORE OUTPUT]` olarak değiştirildi. Desteklenen `openBrowser` enjeksiyonu tarayıcıyı açmadı. Device-token poll transport'u yerelde abort bekleyen promise olarak tutuldu; gerçek polling, token exchange, kullanıcı giriş/onayı veya başarılı OAuth tamamlanması **test edilmedi**. Bu native gerçek-initiation + kontrollü pending-transport kabulüdür; tam canlı OAuth end-to-end kabulü değildir.
- İzolasyon/artefaktlar: gerçek HOME korundu; UUID profil/config/workspace `/private/tmp/dragons-cli-oauth-45abfe26-7f50-452a-bf48-c49d904d7af0/` altında. `launch.mjs`, maskelenmiş `transcript.txt`, `counts.json` ve boş yerel session dosyası repo dışındadır. Native keyring metotları ve credentialStore işlemleri fail-closed; model enjekte edilerek inference engellendi. Disposable kökte `auth.json` oluşmadı. Shell ortamı bütünüyle temizlenmedi; bu nedenle env-i izolasyonu iddiası yoktur.
- Son sayaçlar: `initiation=1`, `initiationHTTP=200`, `pollsHeld=1`, `browserSuppressed=1`, `waiting=1`, `cancelled=1`, `status=1`, `exited=1`; `networkBlocked=0`, `native=0`, `credentialCalls=0`, `inference=0`. Bunlar harness yol sayaçlarıdır, genel OS ağ denetimi değildir. Credential dosyası/gerçek stored secret okunmadı; credential yazılmadı.
- Maskeli native ekranlar, ortak kök `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/images/`: bekleme `computer_use_ad485f9e4e0147e1a4e428a059de3d79.png`; iptal `computer_use_ddddc92cf47e488fabe88f6839637d19.png`; status `computer_use_1182774fe3894d828fcd2b7dfc5ed1a9.png`; temiz çıkış `computer_use_e6fd426163294a2ab9e70439fb5320c7.png`.
- Üretim kaynakları, AGENTS, ROADMAP, updater ve mevcut kirli değişiklikler korunmuştur. Kaynak/test değişmedi; test gate tekrar çalıştırılmadı. Bu alt kabul 1.1 bütününü, başarılı kullanıcı sign-in'ini veya native credential kalıcılığını kapatmaz.

## Doğrulanmış hazırlık

### Güncel kabul özeti — tarihsel kayıtların önceliği

Aşağıdaki eski başarısızlık ve açık-iş kayıtları olay geçmişidir; daha sonraki açıkça kapsamlandırılmış doğrulamalar aynı senaryoyu karşılıyorsa yeniden iş açılmaz. Özellikle CLI-01 menü/PTY, CLI-04 etiket, CLI-05 kısa giriş resize, CLI login/persistence/tek onaylı istek/logout ve kullanıcı tarafından bildirilen Windows kurulum/iptal/yeniden açılış kanıtları korunur.

- **Uygulandı ve otomatik doğrulandı:** Desktop model listesi/reasoning ve updater metadata durum kontrolü dahil sonraki kaynak checkpoint'leri ROADMAP ve M78 raporunda kayıtlıdır. Son uygulama kaynak gate'i 832 test kaydı, 830 başarılı, 2 Linux atlamasıdır (`/tmp/dragons-m78-native-preflight-gate.log`); aşağıdaki “release:check henüz çalıştırılmadı” ifadesi yalnız eski checkpoint'e aittir.
- **Yerel CLI alt kabulü geçti (2026-09-17):** gerçek macOS Terminal'de uzun sarılmış girişin ortasına ekleme/silme ve 80→55→100 sütun resize aşağıdaki ekran kanıtlarıyla doğrulandı. **Yerel kabul açık:** native OAuth bekleyişinde iptal/toparlanma ve yeni Desktop kontrollerinin gerçek etkileşim kabulü. Sahte auth, DOM veya PTY testleri canlı provider/OS kabulüne dönüştürülmez.
- **Dış kabul bekliyor:** Windows/Linux yeni kaynak üzerinde toplu native kabul; Windows'taki önceki başarılı paket denemesi yeni model/reasoning/updater değişikliklerinin kabulü değildir. Yeni credential işlemi kullanıcı müdahalesi, yeni canlı model isteği ayrıca onay gerektirir.
- **M78 ayrı açık:** güvenilir yayın/imza ve gerçek native updater entegrasyon/kurtarma/veri bariyeri. Helper laboratuvarları çalışan üretim updater'ı sayılmaz.

Güncel kullanıcı önceliği: 1.1 kapanmadan 1.2 ve sonrasına ilerlenmez; 1.4 duraklatılmıştır. Aşağıdaki tek CLI alt kabulünün geçmesi 1.1 bütününü tamamlamaz.

### 2026-09-17 — native Terminal uzun sarılmış giriş / orta düzenleme

- **Geçti, yalnız bu CLI alt senaryosu:** macOS Terminal 2.15, gerçek pencere `2875`, Terminal PID `71865`; mevcut `dist/cli.js` üzerinden `main()` (build dosyası zamanı 2026-09-16 23:56:40), 80×32 → 55×32 → 100×32. Sentetik PTY ekranı kullanılmadı. `src/cli/line-input.ts`, mevcut `src/cli/slash-input.test.ts` ve önceki kabul harness kayıtları incelendi; tarihsel `/tmp/dragons-acceptance.MFpS6s` artık yoktu. Kaynak değişmedi; mevcut testler tekrar çalıştırılmadı.
- İzolasyon: `/var/folders/h3/lvl9_1sx3n156z1_fssb94x40000gn/T/dragons-wrap-native-mdjwzm_h/{host.mjs,launch.applescript,workspace,config.json}`. `env -i`, gerçek OS `HOME=/Users/naxoziwus` korunarak yalnız PATH/TERM verildi. Config/profil ve oturum kökü geçici dizinden türetildi. Host mevcut CLI'ye fail-closed sahte model/auth ve fetch engeli enjekte etti; kullanıcı credential dosyası okunmadı, login akışı açılmadı. `/exit` sonrasında `counts.json`: `{"modelCalls":0,"authCalls":0,"fetchCalls":0}`.
- Giriş: `alpha01 bravo02 charlie03 delta04 echo05 foxtrot06 golf07 hotel08 india09 juliet10 kilo11 lima12 MIDDLE november14 oscar15 papa16 quebec17 romeo18 sierra19 tango20 uniform21 victor22 whiskey23 xray24 yankee25 zulu26`. Native CGEvent yazımıyla üç satıra sarıldı. Ctrl+A sonrası başa `[INSERT]` eklendi. Ortadaki `lima12` sözcüğünde caret `lim|a12` konumuna native PID-targeted sağ ok olaylarıyla taşındı; `MID-OK` eklenerek `limMID-OKa12` gözlendi. Altı native Backspace sonrasında `lima12` geri geldi. 55 sütuna daraltmada caret aynı mantıksal konumdaydı; `R` ekleme `limRa12`, Backspace ile geri alma ve 100 sütuna genişletme doğrulandı. Metin gönderilmeden Ctrl+A/Ctrl+K ile temizlendi ve `/exit` çalıştırıldı.
- Gözlem: tek composer, bütün suffix (`… yankee25 zulu26`) korundu; edit alanında hayalet satır veya kayıp metin görülmedi. 55 sütunda eski banner/transcript Terminal tarafından yeniden sarıldı; bu tarihi çıktı normalizasyonu için ayrı bir kabul iddiası değildir. İlk background input gizli pencere nedeniyle reddedildi; yalnız yeni kabul penceresi görünür yapıldı. System Events ok denemesi caret'i taşımadı; başarılı orta konum, doğrudan CGEvent ve sonraki ekranla doğrulandı.
- Ekran kanıtları (yerel, repo dışı; ortak kök `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/images/`): ilk uzun giriş `computer_use_a46de6ab0cd14968a347ee438abacf7f.png`; orta ekleme `computer_use_0c057f7d068247efb4743933f1694a75.png`; silme + 55 sütun `computer_use_f2ce4a76d4ff46768a3dfdda165e978b.png`; daraltma sonrası orta ekleme `computer_use_095c914106c640489baea1d73ada4d99.png`; silme + 100 sütun `computer_use_5e3d0b5a11d1434598fd455f25bef455.png`.
- Native OAuth iptal/toparlanma, Desktop kontrolleri, Windows/Linux ve canlı provider kabulü bu çalışmada yapılmadı. Kaynak/test/ROADMAP değiştirilmedi; yalnız bu belge güncellendi.


### 2026-09-17 — Desktop model / reasoning native kabul ön kontrolü: izolasyon engeli

**Sonuç: bloke; Electron başlatılmadan fail-closed duruldu.** Bu kayıt yeni bir UI başarısızlığı veya başarılı native kabul değildir. Provider seçimi → model önerileri, birebir özel model kimliği, reasoning seçimi → açık Apply ve yeniden açılış kalıcılığı bu çalışmada etkileşimle doğrulanmadı. 1.1 bütünü ve önceki geçerli kanıtlar değişmedi.

- İncelenen kaynaklar: `package.json:53,60`, `desktop/main.mjs:80-110`, `desktop/renderer.js:17-63,139-149`, `src/desktop/host.ts:21-59`, `src/profiles.ts:52-64,98-127`, `src/config.ts:31-40`, `scripts/verify-desktop-smoke.mjs:18-64`. Çalışma ağacı HEAD `c18cd9d`, kirli kaynak snapshot'ıdır. `macos-computer-use` ve `computer-use` yönergeleri yüklendi.
- **Tekrarlanabilir engel:** `pnpm desktop` → `electron desktop/main.mjs` → `createDesktopRuntime(workingDirectory)` yalnız workspace argümanı taşır. Host, parametresiz `createDragonsProfileStore()` çağırır; config, sessions, memory ve skills köklerini buradan alır. macOS config yolu `HOME/Library/Application Support/Dragons Agent/config.json` olarak hesaplanır. Gerçek HOME korunurken geçici config/profil/oturum kökü geçirmek için bu production host girişinde desteklenen seçenek bulunmuyor. `XDG_CONFIG_HOME` macOS dalında kullanılmaz; Electron `userData` izolasyonu da bu ayrı uygulama-config hesabını değiştirmez.
- `openDesktop(runtime)` izole runtime enjeksiyonunu destekler ve mevcut smoke harness bunu kullanır. Ancak bu yol tek başına gerçek yerel reasoning kalıcılığı kabulünü sağlamaz: `desktopLocalControls(runtime)` yalnız `createDesktopRuntime()` tarafından özel WeakMap'e kaydedilmiş runtime için kullanılabilir. Host'un profile/config kompozisyonunu test wrapper'ında kopyalamak, keyfi ortam değişkeni uydurmak veya gerçek kullanıcı profilini kullanmak bu kabulün sınırları içinde seçilmedi. Remote runtime yolu da yerel profil kalıcılığının yerine sayılmadı.
- **Eksik yetenek / sonraki kapı:** production Desktop host'un trusted composition API'sinde açık config/profil kökü ve bağımlılık izolasyonu; örneğin CLI'deki mevcut `configPath` kompozisyonuna denk bir Desktop seçeneği. Bu yalnız engel raporudur: kaynak değişikliği yapılmadı ve öneri uygulanmış/supported özellik gibi sunulmadı. Böyle bir yol sağlandıktan sonra gerçek HOME + temiz ortam + geçici workspace/profil/session ve ayrı Electron userData ile native kabul tekrar yapılmalı.
- Güvenlik / artefakt: Electron veya kurulu uygulama açılmadı, kişisel pencere yakalanmadı; bu nedenle ekran görüntüsü ve launcher artefaktı **yoktur**. Credential/config içeriği okunmadı, login/inference/provider discovery yapılmadı. Yeni süreç/pencere oluşmadığından kapatılacak owned process yoktu. Yalnız bu belge değiştirildi; kaynak, ROADMAP, AGENTS, kurulu uygulama ve önceki kanıtlar korunmuştur. Bu ön kontrol DOM testleriyle veya eski smoke sonucu ile native kabul olarak işaretlenmedi.

### Windows Desktop — kullanıcı tarafından bildirilen manuel kabul

**Sonraki Windows doğrulaması:** Kullanıcı geçerli komutun `/login openai-api` olduğunu doğruladı (`/login openai` provider seçim yardımını gösterir). Özel giriş penceresini X ile kapatma ardından `/status` başarılı. CSS layout düzeltmesi Windows'ta kullanıcı tarafından doğrulandı. Ardından `pnpm desktop:dist` ile üretilip kurulan uygulamada Başlat menüsünden açılış, workspace seçiciden boş klasör seçimi, pencereye sığan ana ekran, `/login openai-api` → boş iptal → `/status` ve kapatıp Başlat menüsünden yeniden açılış adımlarının tamamı kullanıcı tarafından başarılı bildirildi. Bunlar ajan tarafından bağımsız Windows çalıştırması değildir; installer hash'i ve Windows sürümü kaydedilmedi. OAuth, gerçek credential kalıcılığı, model isteği, model/reasoning görsel kontrolleri ve M78 updater kabulünü kapsamaz.

Güncel kaynak test ZIP'i Windows üzerinde `pnpm desktop` ile açıldı. Kullanıcı provider seçimi, slash menüsünde ok/Tab/Escape ve hatasız yeniden açılışı doğruladı. `/login openai` özel API-key penceresini açtı; credential girilmeden iptal edildi. Ardından `/status` yanıtı alındı: `API-key sign-in cancelled.` ve `contextCharacters: 0`, `contextBudgetChars: 120000`, `recentDiagnostics: []`. Boş API-key girişini iptal sonrası yerel komutla toparlanma geçti (kullanıcı kanıtı; ajan tarafından Windows'ta çalıştırılmadı). X ile kapatma, OAuth, gerçek credential kalıcılığı, model isteği ve kurulu EXE kabulü değildir. Geliştirme modunda workspace çalışma dizinidir; model serbest metin alanıdır ve ayrı reasoning kontrolü görünmez. Tam Desktop/1.1 kabulü açık.

- Node `v22.22.3`, pnpm `11.17.0`; `pnpm build` başarılı.
- Başlatma yolları: `pnpm dragons` ve `pnpm desktop` önce TypeScript derler. Kabul CLI'si aynı derlemenin `dist/cli.js` girişinden çalıştırıldı.
- Geçici HOME ve workspace, `mktemp` ile ayrı kökte oluşturuldu. CLI `env -i` ile başlatıldı; ana ortamın API-key/remote-runtime değişkenleri aktarılmadı.
- `createDragonsProfileStore().select()` ile yalnız geçici HOME altında benzersiz `acceptance-mfps6s-cli` profili seçildi. Ana profil/config/credential dosyaları okunmadı veya değiştirilmedi.
- Credential namespace kaynak incelemesi: ChatGPT hesabı adlandırılmış profile bağlı; API-key hesabı hem profile hem provider'a bağlı. Sentetik adlarla iki ayrı profil ve iki provider için hesap kimliklerinin farklı olduğu çalıştırılarak doğrulandı. Bu, gerçek credential kalıcılığı veya profil-geçiş kabulü değildir.

## Gerçek CLI PTY gözlemleri

| Adım | Sonuç | Kapsam / sınır |
| --- | --- | --- |
| Güncel kaynakla etkileşimli açılış | Geçti | Geçici workspace ile composer açıldı. |
| `/` yazma | Başarısız | Komut menüsü görünmedi. |
| `/` ardından Tab | Başarısız | Seçim/tamamlama yerine düz Tab eklendi. |
| `/login` ardından Enter | Beklenen akışla uyuşmuyor | Provider seçimi olmadan aktif `openai-api` için özel maskeli giriş açıldı. |
| Maskeli girişte Escape | Geçti, dar kapsam | Hiç credential girmeden iptal edildi; composer geri geldi. |
| İptal sonrası `/status` + Enter | Geçti | Yerel durum komutu yanıt verdi; terminal girişinin geri geldiği gözlendi. |

### CLI-01 — seçim katmanı CLI'ye bağlı değil

Tekrar: etkileşimli CLI'de `/` yaz, Tab bas; ayrıca boş `/login` komutunu gönder. Kaynak: `src/cli.ts` etkileşimli yolunda çıktı/tamamlama olmadan `createInterface({ input, crlfDelay: Infinity })` kullanılıyor. `/login` provider argümanı yoksa doğrudan `activeProvider` kullanıyor. Ortak seçim metadata/state `src/slash-choices.ts` içinde mevcut, ancak CLI bu katmanı kullanmıyor.

Durum: tekrarlandı; henüz regresyon testi veya düzeltme yok. Ok tuşları, seçim sırasında Enter/Escape ve modele yanlışlıkla gönderim ayrı ayrı doğrulanmadı. Doğrudan `/login chatgpt` geçici devam yolu, menü kabulü değildir.

## İnsan giriş kapısı

Kullanıcı ChatGPT Subscription / device sign-in seçti. Device code ve OAuth verisini araç kaydına almamak için PTY kapatılıp aynı izole HOME/workspace ile macOS Terminal'de CLI açıldı. Launcher shell syntax kontrolü başarılı; Terminal sekmesi `busy=true` bildiriyor. Bu, kullanıcı girişinin başarılı olduğunu kanıtlamaz.

Credential, device code, gerçek provider yanıtı veya özel proje verisi bu raporda tutulmaz. Henüz canlı model isteği gönderilmedi; bunun için ayrıca kullanıcı onayı gerekir.

## Depolama hatası ve CLI yaşam döngüsü düzeltmesi

İlk kullanıcı denemesinde tarayıcı onayından sonra güvenli depoya credential replacement başarısız oldu ve CLI kapandı. Sonraki bağımsız durum kontrolü aynı kabul profilinde `not signed in` ve native storage unavailable sınıflandırması verdi. Giriş tamamlanmış sayılmadı.

**Ortam kök nedeni:** macOS'ta kabul için HOME'u değiştirmek native Keychain keşfini bozdu. Benzersiz hesap ve ayrı `Dragons Agent Acceptance Probe` servisiyle, yalnız sentetik bir değer kullanılarak kontrol edildi: geçici HOME altında native read/write/cleanup çağrıları keychain-not-found sınıfıyla başarısız oldu. Normal HOME altında eksik kayıt kontrolü, sentetik yazma, eşitlik doğrulaması ve silme başarılı oldu. Ana credential hesaplarına erişilmedi. Bu ortam hatası, ürünün file fallback politikasını genişleterek giderilmedi.

**Düzeltilmiş CLI kabul launcher'ı:** OS HOME korunuyor; temiz `env -i` içinde mevcut `main(args, { configPath, workingDirectory })` host-composition seçeneği üzerinden önceki geçici config kökü ve workspace kullanılıyor. Ayrı süreçte aktif profil `acceptance-mfps6s-cli` ve depolama etiketi `macOS Keychain` doğrulandı; giriş durumu halen `not signed in`. Launcher shell ve JavaScript syntax kontrolleri geçti. Bu bir test host wrapper'ıdır; yeni bir son kullanıcı CLI parametresi eklenmedi. Desktop izolasyonu henüz bu yoldan kabul edilmedi.

**CLI-02 — auth hatası etkileşimli döngüyü kapatıyor:** `src/cli.ts` artık login/status/logout hatalarını yerel, sabit ve credential içermeyen mesajla karşılıyor; composer çalışmaya devam ediyor. Tek seferlik auth komutlarının hata yayma davranışı değiştirilmedi.

**CLI-03 — OAuth iptal sinyali iletilmiyor:** etkileşimli controller'ın sinyali `auth.login({ signal })` çağrısına iletiliyor; iptal sonrası yerel komutlar devam edebiliyor.

Kanıt: `src/cli.test.ts` içinde üç auth-error ve bir cancellation regresyonu, düzeltmeden önce davranış nedeniyle **4/4 başarısız**, düzeltmeden sonra başarılı. `pnpm build && node --test dist/cli.test.js dist/provider/codex-auth.test.js dist/credential-store.test.js dist/native-credential-absence.test.js`: **65/65 geçti**. Testler sentetik/in-memory auth kullanır; gerçek OAuth giriş kalıcılığı veya gerçek terminalde Ctrl+C kabulü yerine geçmez. Bu düzeltmeler TUI kaynaklarını değiştirmez.

## Açık kabul

### İkinci kullanıcı girişi sonrası doğrulama

Düzeltilmiş launcher ile kullanıcı ChatGPT girişini tamamladı. Yeni, bağımsız CLI sürecinde aktif profil `acceptance-mfps6s-cli`, auth durumu `signed in`, depolama `macOS Keychain` olarak doğrulandı. Ardından yeniden açılan gerçek PTY'de `/provider chatgpt` ve `/auth chatgpt` aynı sonucu verdi. Bu, credential'ın süreçler arası kalıcılığını doğrular; canlı provider isteğini doğrulamaz.

PTY'de `/model` ve `/status`, ChatGPT için `gpt-5.6-terra` gösterdi. `/reasoning` desteklenen yerel seçenekleri listeledi; `/reasoning low` ardından `/reasoning` değeri `low` olarak gösterdi. Bu aşamada model isteği yapılmadı; reasoning'in yeniden başlatma kalıcılığı henüz kontrol edilmedi.

**CLI-04 — eski model etiketi:** `/provider chatgpt` sonrasında `/status` doğru yeni modeli gösterirken alt durum satırı önceki `gpt-4.1-mini` etiketinde kaldı. Gerçek PTY'de tekrarlandı. Düzeltme: her composer çiziminde güncel `activeModelName` renderer'a aktarılıyor; model/provider/session değiştiren yollar aynı çizim noktasını kullanıyor. Yeni composition regresyonu `/model` ve `/provider` sonrasında güncel etiketi ve sıfır model çağrısını kontrol ediyor. Düzeltmeden önce eski etiket nedeniyle RED; düzeltmeden sonra `pnpm build && node --test dist/cli.test.js dist/terminal*.test.js`: **46/46 geçti**. Gerçek terminal yeniden denemesi hâlâ açık; bu sonuç tam CLI kabulü değildir.

### Ek yerel PTY regresyonları

**Genel gate kapsam düzeltmesi ve sonuç:** `package.json` içindeki `test` komutu `dist/cli/*.test.js` dosyalarını kapsamıyordu. `commands.test` ve `slash-input.test` artık genel test/release kapısına dahil. Bu değişiklikten sonra `pnpm release:check` exit 0: 705 test, 703 pass, 2 skip, 0 fail; typecheck, build ve `PACKAGE_ACCEPTANCE_OK` ardından `RELEASE_CHECK_OK`. Tam yerel çıktı: `/tmp/dragons-acceptance-release-check.log`. Atlanan testler native kabul yerine geçmez. Native uzun giriş, OAuth iptali, Desktop ve M78 açık olduğundan tam 1.1 kabulü verilmedi.

**Auth hata sonrası kısmi native kontrol:** Ağ erişimi `profile-host.mjs` içinde kapalıyken gerçek Terminal'de `/login chatgpt` gönderildi. `authentication failed. Check sign-in and OS credential storage.` mesajından sonra yeni composer göründü; süreç kapanmadı. Kanıt: yerel oturum önbelleğinde `computer_use_c3c36bf21f9a4f28bac83a8584e1bc55.png`. Credential/model isteği kullanılmadı. Hata sonrası `/status` ve OAuth bekleyişinde iptal henüz bu native kontrolde doğrulanmadı; tam auth recovery kabulü değildir.

**CLI-05 yeniden kontrol:** Resize düzeltmesi sonrasında native macOS Terminal'de çalışan pencere ID'siyle 148→55→148 sütun kontrolü yapıldı. 55 sütunda aktif `/login ` seçenekleri genişliğe kırpıldı; Down seçimi ilerletti ve imleç giriş satırında kaldı. Yeniden 148 sütunda seçenekler ve yardım satırı normal genişlikte çizildi. Bu kısa giriş/menü senaryosu geçti; uzun sarılmış girişin native görsel kabulü henüz yapılmadı. Önceki ana ajan doğrulamasında ilgili 74/74 test geçti. Credential girilmedi ve login gönderilmedi. Daraltma kanıtı: `computer_use_010fbb351fc54cfaa755dbba84608e98.png`; genişletme: `computer_use_a18f79310b6447ccacd127901b0d6454.png` (yerel oturum görsel önbelleği).

**CLI-05 — gerçek Terminal resize hatası (açık):** Ağ kapalı, ayrı profil hostu `/tmp/dragons-acceptance.MFpS6s/visual-cli.command` üzerinden macOS Terminal'de açıldı. 148×70 boyutta `/login ` menüsü düzgün göründü. Aynı pencere 55×70'e daraltılıp Down tuşuna basıldığında seçenekler eski genişlikle çizildi, satırlar taştı ve imleç seçeneklerin arasına kaydı. Başlangıç banner'ının scrollback reflow'u tek başına hata sayılmadı; aktif menü/imleç bozulması kabulü engelliyor. Credential girilmedi, login gönderilmedi, ağ/model isteği yapılmadı. Düzeltme ve daraltma/genişletme görsel yeniden kabulü açık.

- **CLI-01 uygulama ve kısmi kabul:** `src/cli/line-input.ts` public readline/key decoder ile CLI'ye bağlandı; tam ekran TUI değiştirilmedi. Son kaynakta CLI/line-input/terminal testleri **61/61 geçti**. Kapsam: seçim sırasında model/auth çalışmaması, ayrı Enter ile gönderim, ok/Tab/Escape, plain non-TTY, approval allow/deny/Ctrl+C, sahte OAuth iptali ve maskeli girişte okuyucu devri. İncelemede kapanış sonrası stdin'in flowing kalması için ayrıca RED → GREEN regresyonu eklendi ve son okuyucu kaldırılınca pause uygulanıyor.
- **CLI-01 gerçek OS PTY:** Ağ erişimi kapalı host ile `/` menüsü ve ok navigasyonu, Tab → ayrı Enter ile credential gerektirmeyen `/login local`, Enter → ayrı Enter ile `/status`, yeni input altında CLI-04 etiketi ve temiz `/exit` geçti. Harness: `/tmp/dragons-acceptance.MFpS6s/verify-picker-pty.py`. Harness'in ilk denemelerinde erken prompt eşleşmesi ve çıkışta PTY çıktısını boşaltmama ayrıştırılıp düzeltildi. Görsel emülatör, resize ve gerçek OAuth/Keychain hata-iptal kabulü açık; deterministik sahte auth testleri canlı kabul sayılmadı.

- **CLI-04:** Derlenmiş gerçek Node CLI, OS PTY üzerinde `/model fixture-cli04` → `/provider chatgpt` → `/status` ile çalıştırıldı. Alt durum satırında önce seçilen fixture modeli, sonra `gpt-5.6-terra` görüldü; eski etiket taşınmadı. `/auth chatgpt` kabul hesabının hâlâ `not signed in / macOS Keychain` olduğunu doğruladı. Model isteği gönderilmedi. Bu PTY kontrolü yukarıdaki açık CLI-04 yeniden denemesini karşılar; görsel terminal-emülatör kabulü değildir.
- **Profil reasoning izolasyonu:** Ayrı geçici config kökünde `pty-a` ve `pty-b` oluşturuldu. A'da `low` seçildi; `/profile select pty-b` CLI'yi temiz kapattı. Yeniden başlatılan B `default` gösterdi. B'de `high` seçilip A'ya dönüldüğünde, yeni CLI süreci A için `Reasoning: low` gösterdi. Test hostunda ağ kapalıydı; credential işlemi yapılmadı. Kanıt kapsamı profil seçimi, süreç yeniden başlatma ve reasoning kalıcılığı/izolasyonudur; tüm state türleri veya credential izolasyonu için tam kabul değildir.
- Tekrarlanabilir yerel harness: `/tmp/dragons-acceptance.MFpS6s/verify-local-pty.py`, `/tmp/dragons-acceptance.MFpS6s/verify-profile-pty.py`. Geçici dosyalar kalıcı release artefaktı değildir.

### Onaylı tek canlı CLI isteği ve logout

Kullanıcının açık onayıyla `main()` tek seferlik CLI yolu, aynı izole kabul profili ve workspace ile çalıştırıldı. Gerçek transport çağrısı öncesinde model `gpt-5.6-terra` ve reasoning effort `low` eşleşmesi doğrulandı. Sayaçlı fetch sınırı yalnız bir Codex responses isteğine izin verdi; ek endpoint ve ikinci ağ isteği kapalıydı. Ham credential/yanıt çıktısı alınmadı; CLI yazıları yalnız beklenen kısa metin eşleşmesi için sınıflandırıldı.

Sonuç: **başarılı**, model isteği **1**, transport denemesi **1**, HTTP **200**, beklenen kısa metin eşleşmesi **true**, süreç çıkışı **0**. Config'teki `low` değeri yeni süreçte gerçek istek gövdesine taşındı. Built-in workspace araç listesi boşaltıldı; kalan host araçları için approval input EOF olduğundan mutasyon/execute onayı verilmedi. Gerçek yanıt gövdesi rapora veya çıktı dosyasına kaydedilmedi.

Sınır: bu doğrulama gerçek provider ve CLI composition kullanır, ancak non-TTY tek-seferlik modda, sınırlayıcı test host wrapper'ı ile yapıldı. Etkileşimli terminal render/klavye akışının veya Desktop'ın canlı kabulü yerine geçmez.

Ardından kabul profilinde CLI `auth logout --provider chatgpt` başarılı oldu; ayrı CLI durum süreci **not signed in / macOS Keychain** doğruladı. Ana profil hesabı değiştirilmedi. Yeni canlı istek için yeniden kullanıcı onayı gerekir.

- CLI-01 regresyonu, düzeltmesi ve gerçek terminal yeniden denemesi.
- Düzeltilmiş ortamda kullanıcı ChatGPT girişi, native persistence ve yeniden başlatma doğrulaması; CLI-02/CLI-03 gerçek terminal yeniden denemeleri.
- ChatGPT giriş, yeniden başlatma, `/auth`, `/model`, `/reasoning`, onaylı kısa istek ve `/logout`.
- Profil değiştirme ve ayar/credential izolasyonunun gerçek uygulama yolundan kontrolü.
- CLI tamamlandıktan sonra Electron mouse/klavye akışı; API-key maskeli pencerenin iptal/kapatma/yeniden başlatma davranışları (ChatGPT device sign-in maskeli API-key penceresini tek başına doğrulamaz).
- Son material değişiklikten sonra `pnpm release:check`. Henüz çalıştırılmadı; build sonucu bunun yerine geçmez.
- Son kabul raporu ve doğrulanan alt adımların tamamlanması. M78 dağıtım/güncelleme kabulü ayrıca açık.

## Kullanıcı doğrulamalı Desktop OAuth kabulü

İzole `acceptance-0939bb22-2e78-4c05-a464-6d0f67f81daa` profiliyle gerçek Desktop üzerinde kullanıcı şu adımları başarılı bildirdi: login → signed in; logout → not signed in; OAuth onayı verilmeden bekleyişte `/logout chatgpt` ile iptal → not signed in → `/status` yanıtı; yeniden gerçek login → pencereyi kapatma → ana ajanın aynı profili yeni süreçte açması → `/auth chatgpt` ile giriş kalıcılığı; son `/logout chatgpt` → signed out → `/auth chatgpt` ile not signed in.

Kanıt türü: gerçek girişi yapan kullanıcının sonuç bildirimi; ana ajan credential içeriğini okumadı. Yeniden açılışta PID 32609 için `ready:1` doğrulandı. Model çağrıları test IPC korumasıyla engelliydi. Providersız logout komutunda test allowlist uyarısı görüldü; tam `/logout chatgpt` komutu başarılı oldu. Bu, üretim logout hatası değildir. Test profilinde son durum kullanıcı tarafından not signed in olarak doğrulandı; pencere kapanışı bundan ayrı işlemdir.

Sınırlar: bu kabul Desktop ChatGPT OAuth akışına aittir; CLI native OAuth, diğer credential/provider türleri, çoklu gerçek hesap izolasyonu, Windows/Linux ve M78 kurulum kabulü yerine geçmez. Secret, token ve doğrulama kodu kaydedilmedi.

## Sonraki kabul checkpoint'i — öneriler ve kapanış

Önceki kısmi matrisin devamında altı provider için New session/Resume kimlik kontrolleri ve native öneri listeleri tamamlandı. OpenAI API 2, ChatGPT 4, Anthropic 3, Gemini 3, OpenRouter 3 katalog seçeneği; Local yalnız `qwen2.5-coder:7b` varsayılanını gösterir. Local boş katalog, boş UI listesi demek değildir. Ayrıntılı tablo ve ekran/AX kanıtları aşağıdaki geçici artefakt kökündeki `suggestions-acceptance.md` ve `remaining-suggestions-acceptance.md` içindedir. Ana ajan Local ekranını ayrıca inceledi: tek varsayılan ve `access not verified` etiketi görünür.

Kapanış yarışı üretim `close()` sıralamasında doğrulandı ve giderildi: renderer IPC handler'larından önce kapatılır. Ana ajan build + `dist/desktop-shutdown.test.js` regresyonunu doğruladı. Düzeltme sonrası yeni Electron PID 8017 yalnız SIGTERM ile exit 0 verdi; yeni süreç çıktısında `dragons:events` hatası yoktu. Guard sayaçları fetch/native/inference/auth=0/0/0/0; kaynak hash'leri kabul boyunca sabitti. Önceki -9 kapanışının nedeni kanıtlanmış değildir.

Son maddi değişiklik sonrası ana ajan `pnpm release:check` exit 0 doğruladı; log `/tmp/dragons-phase1-desktop-shutdown-release-check.log`. Bu kanıt native OAuth, Windows/Linux veya M78 üretim updater kabulü değildir; 1.1 açık kalır.

## 2026-09-17 — Faz 1 / 1.1 gerçek Electron izolasyon devam kabulü

**Kısmi gerçek-UI kabul:** önceki host izolasyonu engeli aşıldı; gerçek `createDesktopRuntime(workspace, {configPath, profileName})` ve `openDesktop(runtime)` kullanıldı. DOM mock veya renderer JS enjeksiyonu yok. Provider menüsü, exact custom ID, açık reasoning Apply ve gerçek uygulama restart kalıcılığı gözlendi. Tüm model önerilerinin ve provider değiştirerek session açma matrisinin kabulü bu süreli turda tamamlanmadı; bu kayıt tek başına 1.1'i kapatmaz.

Geçici artefakt kökü: `/var/folders/h3/lvl9_1sx3n156z1_fssb94x40000gn/T/dragons-desktop-native-lfax4_ke`. Workspace: `workspace/`; base config: `config.json`; profil: `acceptance-65dddff9-d8c4-4af3-99cf-56b9075609d3`. Gerçek config: `profiles/acceptance-65dddff9-d8c4-4af3-99cf-56b9075609d3/config.json`. HOME gerçek `/Users/naxoziwus` olarak korundu; Electron userData geçici köke alındı. Config kökü Keychain sandbox değildir; UUID adı gerçek credential namespace'iyle çakışmayı önler.

Yeniden üretim: repo `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` executable'ını `env -i HOME=/Users/naxoziwus PATH=/usr/bin:/bin:/usr/sbin:/sbin` ile yukarıdaki kökün `launch.mjs` dosyasında çalıştır. Launcher gerçek dist host ve `desktop/main.mjs` import eder. İlk top-level `await app.whenReady()` denemesi penceresiz bekledi; sadece geçici launcher üretim main gibi `void (async () => { ... })()` örüntüsüne düzeltildi. Sandbox kapatılmadı.

| Gözlem | Aynı geçici kökte screenshot |
| --- | --- |
| Provider menüsü: Host default, OpenAI API, ChatGPT Subscription (Experimental), Anthropic, Google Gemini, OpenRouter, Local Model | `providers.png` |
| chatgpt/gpt-5.4 için high seçilince bilgi hâlâ default; Apply etkin | `before-apply.png` |
| Apply reasoning tıklanınca Reasoning: high | `after-apply.png` |
| PID 88476 kapanıp aynı profil PID 89224 ile açıldı; New session sonrası Reasoning: high | `after-restart.png` |
| `Acme/Exact.Model-2026:Case` Model alanından New session'a ve session JSON'a aynen geçti; reasoning unsupported/disabled | `custom-id.png` |

Disk doğrulaması: config `reasoning.chatgpt["gpt-5.4"] = "high"`; custom session `75036391-7ac4-4b72-bdb1-c8969fddb320`, restart session `a025572a-d8c4-4353-9d8a-25c96869e462`. Üç session dosyasında mesaj sayısı 0. Credential içeriği yok.

Guard sınırı: inherited credential environment alınmadı; global fetch, native AsyncEntry get/set/delete ve local login/loginApiKey/auth/logout fail-fast. Renderer gerçek asset allowlist'i korundu, Chromium background networking kapatıldı ve DNS deny kuralı kullanıldı. `counts-88476.json` ile `counts-89224.json`: fetch/native/inference/auth hepsi 0. Runtime run guard'ı yalnız metod mevcutsa kurulur; ek somut inference-yok kanıtı boş mesajlar ve Send request kullanılmamasıdır. Bu kayıt OS firewall veya packet capture kanıtı değildir. Login/auth/model isteği gönderilmedi.

Electron popup AX set_value çocuk seçeneklerini okuyamadı; background pixel değişiklik yapmadı. Araç escalation sonrası foreground AXPress ile reasoning menüsü ve high seçimi çalıştı; ürün hatası olarak etiketlenmedi. Yalnız sahip olunan 80446, 88476, 89224 süreçleri sonlandırıldı. Kurulu uygulama/gerçek config/profil/credential, AGENTS ve diğer repo kaynakları değiştirilmedi; kurulum, commit, canlı model veya 1.4 yok. Screenshot'lar repo dışında tutuldu.

## Native provider/new-session/resume matrisi — 2026-09-17 ek kabul

**PASS (sınırlı):** Altı kayıtlı provider gerçek Electron UI üzerinde seçildi; default model alanı provider ile değişti, New session oluşturuldu ve disk kimliği doğrulandı. Her oturumda başka provider seçilip Resume ile kayıtlı provider/model geri geldi. **BLOCKED / eksik:** Model öneri açılır listesinin bütün seçeneklerini registry kataloğuyla native karşılaştırma bu zaman kutusunda tamamlanmadı; default alanının değişmesi tam katalog kabulü değildir. 1.1 bütünü, M78 ve Windows/Linux dış kapıları kapanmadı.

Önce launcher, güncel host/renderer/builtins incelendi. Aynı izole kök/profil, gerçek HOME ve guards korundu; PID 91234, pencere 3112. Yalnız background AX işlemleri kullanıldı, foreground/raise yapılmadı. Popup set_value başarısız oldu; açık menünün WebArea altındaki AXMenuItem öğesine AXPress seçim yaptı (ayrı native popup öğesi background sınırı tarafından reddedildi). Her değişiklik screenshot ile yeniden gözlendi. Ürün hatası doğrulanmadı; kaynak değiştirilmedi.

| Provider | UI + diskte model | Yeni session ID | Resume öncesi farklı seçim | Sonuç |
| --- | --- | --- | --- | --- |
| openai-api | gpt-4.1-mini | 59a165c0-3fdc-494a-8cea-87f400abaaf3 | chatgpt | PASS |
| chatgpt | gpt-5.6-terra | dad9bf27-82ba-49b8-8bc2-fd1b2072a7cd | openai-api | PASS |
| anthropic | claude-sonnet-5 | f96f8814-5c51-4f3e-b9a6-61c7cb1b0e64 | gemini | PASS |
| gemini | gemini-2.5-flash | 9569f4e1-2cac-4232-9a9b-bcce994eedbf | openrouter | PASS |
| openrouter | openai/gpt-4.1-mini | a7592375-7204-4f92-b409-0358ce6fa4f5 | local | PASS |
| local | qwen2.5-coder:7b | b8d6b617-25a2-470e-a692-efa65b177dd9 | chatgpt | PASS |

Registry metadata yerel olarak `createBuiltInProviderRegistry({apiKeyAuth:false}).list()` ile okundu: UI'deki altı etiket ve yukarıdaki altı default birebir eşleşti. Katalog boyutları openai-api 2, chatgpt 4, anthropic 3, gemini 3, openrouter 3; local için statik katalog yok. Bunlar metadata sayılarıdır, tüm native önerilerin doğrulandığı iddiası değildir.

Dokuz session JSON'un tümünde mesaj sayısı 0; önceki custom ID ve reasoning kanıtı korunmuştur. `counts-91234.json`: fetch/native/inference/auth = 0/0/0/0. Send request, auth/login veya credential işlemi yok. TERM sonrası süreç hâlâ mevcut olduğundan yalnız sahip olunan PID'ye KILL uygulandı; son `ps -p 91234` boş/exit 1 ile kapalı doğrulandı.

Screenshot'lar önceki geçici artefakt köküne kopyalandı (araç cache'i son 20 görüntüyü tutuyor; ilk openai screenshot çifti kopyalama anında artık yoktu, bu satırın UI kanıtı tool transcript ve session JSON ile sınırlıdır). Aşağıdaki dosyalar kökte mevcut:

| Kanıt | Screenshot dosyası |
| --- | --- |
| Anthropic new / resume | `computer_use_60dc779a92134d2db04add4041397884.png` / `computer_use_9474125b6e794c90aea7d9e686e95067.png` |
| Gemini new / resume | `computer_use_213254b7e656476da054cf0577dc2f6f.png` / `computer_use_a37e99e872ab46ab9d89269d7d1d2532.png` |
| OpenRouter new / resume | `computer_use_132c28a726754399a7f7813dfff38899.png` / `computer_use_fb1728c2c9d841358ee1555351ac7708.png` |
| Local new / resume | `computer_use_1387450afd01404f82a0d3b90f81c61c.png` / `computer_use_a6f0e8041c404ec3ae20e7be6be10dbb.png` |
| ChatGPT new | `computer_use_5cdeb1c745bf4a1daae0de414dd8d518.png` |
| ChatGPT resume öncesi OpenAI seçili / resume sonrası ChatGPT geri | `computer_use_4971d3d6c5464857b250c77795bf472c.png` / `computer_use_7d50e28d861544c8a2982794f94ce326.png` |

### Secret modal layout follow-up (2026-09-17)

- Scoped `.secret-page` styles isolate the prompt from the main workspace grid and low-height media rules. CSP, asset allowlist, password type and autocomplete remain unchanged.
- `pnpm build` and focused `node --test scripts/desktop-secret-layout.test.mjs scripts/desktop-secret-prompt.test.mjs`: **4/4 PASS**. Real Electron geometry checks use the actual 520×300 window plus a 320×240 content viewport; title/description/label/input/actions do not overlap or overflow horizontally and actions remain visible. Blank Cancel dispatch crosses the real preload/IPC boundary, resolves undefined, destroys the dialog, and permits a second prompt. This is automated DOM-click evidence, not native pointer acceptance.
- Negative sensitivity check (`DRAGONS_LAYOUT_BASELINE=1`) removes only the page class in a disposable renderer; fails “actions must follow input”. No production source was reverted.
- Isolated native blank prompt after fix is visibly separated: screenshot `/Users/naxoziwus/.hermes/profiles/naxoziwus/cache/images/computer_use_e71c21e471c74ce38b0eb4f7fef2f8d1.png`. Launcher `/tmp/dragons-secret-cancel-native.mjs`; final PID 79877 counters: fetch/native/inference/auth/secretNonempty all 0; promptOpened 1, promptClosed 0 before cleanup.
- **Historical automation limitation:** background coordinate input refused `off_space_or_ax_unresolved`; foreground targeting did not establish Cancel acceptance (`computer_use_63af7fc937684064a7493cb624c7d905.png`). That owned process was terminated; no credentials were entered.
- **Subsequent native Cancel acceptance — user verified:** the parent reopened the isolated blank dialog with pre-dispatch IPC restrictions and confirmed one prompt open, zero fetch/native/inference/auth/nonempty-secret counters. The user clicked Cancel and reported `API-key sign-in cancelled.` followed by a successful `/status` response: provider `openai-api`, model `gpt-4.1-mini`, messageCount 0, hasContinuation false, contextCharacters 0. This closes the native Cancel → local status subcase; evidence is the user's real interaction, not an automated click claim. Accepted ChatGPT/Escape checks were not repeated. No updater work or credential entry was required.
