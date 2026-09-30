# 2.2 Inline Context References — geliştirme kaydı

Tarih: 2026-09-23. Durum: **scoped geliştirme kabulü tamamlandı; bağımsız yeniden inceleme PASS**. Bu kayıt yayın izni veya native platform kabulü değildir.

## Kapsam

- Yeni açık kullanıcı girdisindeki `@file(path)`, `@folder(path)`, `@diff`, `@url(https://host/path)` ortak `runAgent` girişinde bir kez çözümlenir. CLI tek görev/etkileşimli ve Desktop runtime aynı sınırı kullanır.
- Dosya kapsamı workspace-relative, hassas içerik/yol, link ve boyut kontrolleriyle sınırlıdır. Folder yalnız sınırlı ve sıralı doğrudan giriş metadatasıdır. Diff mevcut read-only Git yardımcı/filtre engellerini kullanır.
- URL ayrı EXECUTE onayı ister; model araç kataloğuna genel ağ yetkisi eklenmez. Hedef açıkça gösterilir. HTTPS, DNS public IPv4 kontrolü ve bağlantı adresi sabitleme, redirectsiz/kimlik bilgisiz istek, süre/boyut/tür/UTF-8 sınırları uygulanır. İptal bekleyen onayı ve ağ/Git çalışmasını sonlandırır.
- İçerik kaynak etiketli, güvenilmeyen danışma verisidir. Model/araç çıktısı, eski oturum metni ve eklerdeki referanslar tekrar çözümlenmez. Kullanım ve kesin sınırlar: [advanced usage](advanced-usage.md#inline-context-references).

## Deterministik kanıt

Yeni test dosyaları:

- `tests/core/inline-context.test.ts`: ayrıştırma/literal koruma, dosya/folder/diff, kapsam/hassas veri/link/bütçe retleri.
- `tests/core/inline-context-url.test.ts`: sahte DNS/HTTPS üzerinden SSRF, DNS sabitleme, redirectsiz ve kimlik bilgisiz istek, yanıt/iptal sınırları. Gerçek internet veya provider kullanılmaz.
- `tests/runtime/inline-context-input.test.ts`: gerçek CLI/runtime/Desktop giriş sözleşmeleri; model isteğine eklenme, tekrar genişletmeme, URL ret/iptal akışı.
- `tests/desktop/desktop-renderer.test.ts`: tam URL onay sunumu ve eksik/zararlı sunum kapsamının reddi.

Çalıştırılan komutlar:

```sh
pnpm build:tests
node --test .test-build/core/inline-context.test.js .test-build/core/inline-context-url.test.js .test-build/runtime/inline-context-input.test.js .test-build/desktop/desktop-bridge.test.js .test-build/desktop/desktop-renderer.test.js
# 79 başarılı, 0 hata (son renderer testi eklenmeden önce)
node --test .test-build/core/inline-context.test.js .test-build/core/inline-context-url.test.js .test-build/runtime/inline-context-input.test.js .test-build/desktop/desktop-renderer.test.js
# son build sonrasında 57 başarılı, 0 hata
pnpm release:check
# 1222 test: 1220 başarılı, 2 atlanan, 0 hata
# typecheck/build/package başarılı; RELEASE_CHECK_OK
```

Yukarıdaki ilk gate sonuçları, aşağıdaki onay-zaman aşımı onarımından önceki durumu gösterir; güncel kabul kanıtı aşağıdadır. Önceki LSP canlı denemeleri yeniden yapılmadı; 2.3'e geçilmedi.

## Onay-zaman aşımı yaşam döngüsü onarımı

Bağımsız inceleme P2 kusurunu doğruladı: resolver'ın 60 saniyelik sinyali CLI/runtime onay tüketicisine ulaşmıyordu. Terk edilen CLI `answers.next()` ilk takip görevini yutuyor; runtime onayı da run temizliğine kadar cevaplanabiliyordu. Aşağıdaki onarım bağımsız yeniden incelemeden geçti.

- `src/agent.ts`: `authorize` ikinci, isteğe bağlı parametrede onayın yaşam süresi sinyalini alır. URL onayına çözümleme sinyali; normal araçlara ve LSP başlangıcına run sinyali aktarılır. Resolver abort dinleyicisi tüm sonlanma yollarında temizlenir.
- `src/cli.ts`: composer ve onaylar aynı girdi sahibini kullanır. Onay iptal olduğunda alttaki okunmakta olan satır korunur ve sonraki tüketiciye aktarılır; terk edilen tüketici satırı tüketemez veya bekleyen okumayı temizleyemez. Bu, her seferinde yeni `iterator.next()` açan bir Promise yarışı değildir. Run iptali ve onay zaman aşımı aynı güvenli sahiplik aktarımını kullanır.
- `src/runtime.ts`: onay-lifetime sinyali bekleyen onaya aktarılır; timeout anında pending kayıt senkron silinir, run temizliği beklenmeden eski approval ID reddedilir.
- `tests/runtime/inline-context-input.test.ts`: gerçek `main([])` + `PassThrough` üzerinden yalnız 60 saniyelik timeout sinyali kontrollü abort ile değiştirilir. URL zaman aşımı veya Ctrl+C sonrasında tek sıradan takip girdisi ve `/exit` gönderilir; ilk takip girdisinin modele ulaştığı doğrulanır. Desktop testi timeout'un hemen ardından eski onayın kabul edilmediğini ve başarısız girdinin kalıcılaşmadığını doğrular. Duvar saati beklemesi, ağ veya canlı provider gerekmez.

RED: üretim düzenlemelerinden önce `pnpm build:tests && node --test .test-build/runtime/inline-context-input.test.js` — **6 başarılı, 2 hata**. CLI `tasks: []` döndürdü; Desktop zaman aşımına uğramış onayı yanlışlıkla `true` ile kabul etti.

GREEN odaklı kapı:

```sh
pnpm build:tests && node --test .test-build/core/inline-context.test.js .test-build/core/inline-context-url.test.js .test-build/runtime/inline-context-input.test.js .test-build/cli/cli.test.js .test-build/cli/slash-input.test.js .test-build/core/lsp-approval.test.js .test-build/core/lsp-diagnostics.test.js .test-build/integration/lsp-presentation.test.js .test-build/desktop/desktop-bridge.test.js .test-build/desktop/desktop-renderer.test.js
# 174 başarılı, 0 hata; normal CLI iptali, raw/slash input, LSP ve Desktop dahil
pnpm release:check
# 1225 test: 1223 başarılı, 2 atlanan, 0 hata
# typecheck/build başarılı; PACKAGE_ACCEPTANCE_OK; RELEASE_CHECK_OK
```

Tam release kapısı son maddi kaynak/test değişikliğinden sonra bir kez çalıştırıldı; sonraki değişiklikler yalnız kabul belgeleridir. Bağımsız yeniden inceleme aynı odaklı 10 test dosyasını yeniden çalıştırdı: **174 başarılı, 0 hata, 0 atlanan**. CLI okuma sahipliği, callback sinyal uyumluluğu ve runtime onay temizliği incelendi; engelleyici kusur bulunmadı (**PASS**). Release ve yeniden inceleme test kayıtları doğrulandı; `git diff --check` başarılı. Commit/push yapılmadı.

## İnceleme kapsamı ve kabul sınırları

Bağımsız inceleme yeni kullanıcı girdisi işaretinin çağrı yollarını, EXECUTE onayının tek runtime otoritesini, URL bağlantı sabitlemesini ve dosya/Git hassas içerik dışlamalarını kapsadı; bulunan onay yaşam döngüsü kusuru onarıldı ve yeniden incelendi. Gerçek internet, native Desktop GUI/PTY ve platformlar arası canlı doğrulama yapılmadı. IPv6, query/fragment, redirect, sıkıştırılmış veya büyük URL içerikleri desteklenmez. TUI URL onayını sunamadığı için reddeder. Dosya sistemi düşmanca eşzamanlı mutasyona karşı OS sandbox değildir; hassas veri saptama tam bir secret scanner değildir. M78 ve diğer üretim yayın kapıları değişmedi.
