# 2.3 Session Search — yerel kabul kaydı

Tarih: 2026-09-23. Durum: **scoped geliştirme kabulü tamamlandı; bağımsız yeniden inceleme PASS**. İki doğrulanmış engel giderildi. Bu kayıt üretim yayın izni değildir.

## Kapsam

- CLI etkileşimli/tek-sefer ve Desktop model çağrıları ortak `session_search` / `session_read` araçlarına ulaşır; tek araç yetkisi `runAgent()` içinde kalır.
- Kaydedilmiş konuşmalar ve yeni tamamlanan ön-plan turlarının sınırlı araç gözlemleri aranabilir. Eski kayıtlardan saklanmamış çıktı türetilmez.
- Her çağrıda sınırlı bellek-içi ters indeks kurulur; READ yolu indeks/dizin/kilit yazmaz. Profil ve kanonik workspace dışı kayıtlar görünmez.
- Değişen kayıtta revision kontrolü, silme/yeniden başlatma, sayfalama, iptal, bozuk/büyük dosya, dosya kimliği ve symlink sınırları deterministik testlerle kapsanır.
- Provider devam durumu, araç argümanları, onay kararları ve credential depoları indekslenmez. Bilinen credential biçimleri maskelenir; keyfi metinde eksiksiz sır tespiti iddiası yoktur.

## İnceleme sonrası düzeltmeler

- **Credential alanları:** ortak streaming redactor; JSON/tırnaklı alanlar, `cookie`, `set-cookie` ve `id_token` ayraç/camel-case varyantları; çok değerli cookie başlıkları. Yeni gözlemler kayıttan önce, eski kayıtlar arama/okuma projeksiyonunda maskelenir. Eski dosyalar yeniden yazılmaz. Her iki-parça bölme noktası ve karakter-karakter akış test edilir.
- **İç içe onay reddi:** `runAgent()` tamamlanma olayına sunumdan ayrı, yetki katmanının ürettiği `observationOutput` ekler. Recorder bu projeksiyonu kullanır; LSP ret kararı model/UI çıktısında kalır fakat yeni kalıcı gözleme girmez. Yazma sonucu ve onaylanmış tanılar korunur. Aynı ret cümlesini içeren sıradan araç metni silinmez; ayrım kelime eşleştirmesine dayanmaz.
- Gerçek CLI giriş noktası ve ortak runtime/Desktop köprüsü üzerinden sentetik credential çıktısı ile LSP izin/ret senaryoları; ham oturum dosyası, arama ve okuma kontrolleri eklendi. Ağ/provider çağrısı kullanılmadı.

## Doğrulama

Düzeltme öncesi yeni regresyonlar: **40 başarılı, 7 hata**; hatalar credential sızıntısını ve kalıcı iç içe LSP ret metnini doğruladı.

Son odaklı komut:

```sh
pnpm build:tests && node --test .test-build/runtime/runtime-redaction.test.js .test-build/core/session-search.test.js .test-build/runtime/session-search-input.test.js .test-build/core/lsp-diagnostics.test.js .test-build/integration/lsp-presentation.test.js .test-build/checkpoint/checkpoint-diff.test.js .test-build/core/inline-context.test.js .test-build/core/inline-context-url.test.js .test-build/runtime/inline-context-input.test.js
```

Sonuç: **74 başarılı, 0 hata, 0 atlanan**. Ortak redactor tüketicileri ile önceki inline-context onay/iptal ve girdi sahipliği regresyonları da bu seçime dahil.

Önceki **1234 başarılı, 2 atlanan** release sonucu düzeltme öncesi snapshot'a aittir; yeni kabul kanıtı değildir. İlk düzeltme sonrası tam kapı yalnız M8'in sabit olay beklentisinde yeni `observationOutput` alanı nedeniyle başarısız oldu (**1238 başarılı, 1 hata, 2 atlanan**). Beklenti güncellendi; `pnpm build:tests && node --test .test-build/integration/m8-streaming.test.js`: **4 başarılı, 0 hata**.

Son işlevsel/test değişikliğinden sonra bir kez çalıştırılan `pnpm release:check`: **1239 başarılı, 2 atlanan, 0 hata** (1241 test); typecheck, build ve paket doğrulaması başarılı (`PACKAGE_ACCEPTANCE_OK`, `RELEASE_CHECK_OK`). Ardından yalnız kabul sonuç kaydı güncellendi. `git diff --check` temiz.

## Bağımsız yeniden inceleme

Onarımlar ve etkilenen ortak redactor/runtime olay sınırları bağımsız olarak incelendi; doğrulanmış engel bulunmadı (**PASS**). M8 dahil 10 odaklı test dosyası yeniden çalıştırıldı: **78 başarılı, 0 hata, 0 atlanan**. Credential projeksiyonları, doğrudan/iç içe ret, custom-tool alan enjeksiyonu ve `null`/boş/fallback ayrımı ayrıca incelendi. Odaklı test kaydı doğrulandı; kaynak değişmediği için tam release kapısı tekrarlanmadı.

## Kabul sınırları

- Diskte kalıcı indeks yok; her çağrı en fazla 1000 girdi / 8 MiB tarar, dosya başına 1 MiB. Sınır aşılırsa `limited` bildirilir; sınırlı küme tüm geçmiş anlamına gelmez.
- Gözlemler son 100 kayıt ve kayıt başına 2000 karakterle sınırlı. İptal/başarısız tur, tek-sefer CLI ve çocuk-içi olaylar ayrıca kalıcılaştırılmaz.
- Eski kayıtlar taşınmadı veya yeniden yazılmadı. Geçmişte provenance olmadan saklanan ret metni ile sıradan alıntı geriye dönük kelime eşleştirmesiyle ayrıştırılmaz.
- Arama bir dosya-sistemi transaction snapshot'ı değildir. Revision ile okuma değişikliği yakalar; eşzamanlı arama sayfaları kayabilir.
- Canlı provider/ağ, imzalı native paket ve farklı işletim sistemi kabulü yapılmadı. Bağımsız güvenlik/doğruluk yeniden incelemesi geçti; üretim yayın kapıları ayrı ve açıktır. 2.4 kapsamına geçilmedi.

Ayrıntılı kullanıcı ve geliştirici sözleşmesi: [Advanced usage — Session search](advanced-usage.md#session-search).
