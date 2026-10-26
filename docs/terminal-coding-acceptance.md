# CT03 — Temel terminal coding akışı

> **Tarihsel kaynak:** Bu belge daha büyük 2026-10-23 dirty ağacını anlatır; satır numaraları ve sonuçları ayrı terminal dalının kanıtı değildir. Ayrıştırılmış aday ve yeni sonuçlar için [CT05 kabul kaydı](terminal-delivery-scope.md).

## Kapsam ve kaynak — 2026-10-23

macOS arm64, Node v22.22.3, pnpm 11.17.0; `main` / `470aa97` tabanlı **commit edilmemiş çalışma ağacı**. Bu kayıt üç platform veya canlı provider kabulü değildir. Windows x64 ve Ubuntu x64 aynı kaynak üzerinde henüz çalıştırılmadı. Desktop/Web geliştirmesi bu turun dışında kaldı.

Değişen davranışlar:

- TUI `/provider`, `/model`, `/new`, `/reset` ve `/resume` işlemleri iptal edildiğinde geç dönen başarı/hata mevcut oturumu ve konuşmayı değiştirmez. Runtime'a kabul edilmiş yeni oturumun diskten geri alınması iddia edilmez; sunum katmanı geç sonucu benimsemez.
- Interactive CLI, çağıranın verdiği araç dizisini kopyalar. Oturumu aynı bindings ile yeniden açmak plan/MCP araçlarını çağıranın dizisine ekleyip `Duplicate tool name` hatası üretmez.
- MCP client/server SDK 2.0.0 → **2.3.0**; lockfile paket yöneticisiyle yenilendi. HTTP test sunucuları stateless transport/server örneğini istek başına oluşturur. Üretim yetki, dosya/çıktı sınırı veya kimlik bilgisi politikası gevşetilmedi.
- CI terminal işine macOS/Linux için mevcut izole POSIX PTY kontrolü eklendi. Windows'ta POSIX harness çalıştırılmaz; bu Windows ConPTY kabulü yerine geçmez.

Scoped kaynak kimliği: `431103bfa8392a0d52fca6c0b99f474d92a6220e30576f81c54b037da9e9662e`. Sıralanmış aşağıdaki dokuz yol için `path + NUL + SHA256(bytes) + LF` kayıtlarının birleşiminin SHA-256 değeridir; bütün dirty ağacın veya Git commit'inin hash'i değildir:

`.github/workflows/ci.yml`, `package.json`, `pnpm-lock.yaml`, `src/cli.ts`, `src/tui/controller.ts`, `tests/integration/m50-streamable-http.test.ts`, `tests/integration/m51-mcp-authentication.test.ts`, `tests/integration/terminal-coding-flow.test.ts`, `tests/tui/tui-controller.test.ts`.

## Kaynak → kullanıcı akışı → kanıt matrisi

| Akış | Üretim yolu | Doğrulanan kanıt | Sınır |
|---|---|---|---|
| Başlat, provider/model seç | `src/cli.ts`, `src/tui/controller.ts` | `tests/integration/terminal-coding-flow.test.ts`: gerçek `main`, registry, session store; yerel seçim provider çağırmaz | Provider kontrollü fixture; canlı hesap/model erişimi değil |
| Mesaj/stream | CLI session loop, TUI controller/terminal | Composition testinde streamed sonuç; `scripts/verify-tui-pty.py` gerçek PTY'de iki parça ve duplicate-final kontrolü | Ağ/provider stream uyumluluğu ayrı |
| Dosya oku | `src/tools.ts` → `runAgent` | Composition: Unicode/boşluklu workspace ve dosya adı, gerçek `read_file`, onay istemeden sonuç | Genel containment/bozuk dosya sınırları `tests/core/tools.test.ts` ve ilgili belge testlerinde korunur |
| WRITE/EXECUTE onayı ve ret | `src/agent.ts`, CLI/TUI approval yolu | Gerçek `write_file` ve `shell`: onay öncesi yan etki yok, varsayılan ret dosya oluşturmaz, açık onay çalışır | Kişisel workspace kullanılmaz |
| Komut hata/iptal | `src/tools.ts`, CLI/TUI cancellation | Gerçek Node alt süreci, hata çıktısı, bekleyen komutu iptal, iptalden sonra provider continuation olmaması | Windows shell alıntılama aynı testte hedeflenir; Mac sonucu Windows çalıştı demek değildir |
| Model iptali/toparlanma | CLI/TUI runtime yolu | Bekleyen fixture AbortSignal alır, sonraki mesaj tamamlanır | Canlı provider iptali değil |
| Oturum değişikliği iptali | `src/tui/controller.ts` | `tests/tui/tui-controller.test.ts`: beş komut × geç başarı/hata = 10 regresyon | Kabul edilmiş runtime oturumu rollback edilmez |
| Kapat/yeniden aç | CLI `session resume`, TUI `--resume` | Composition: kaydedilmiş provider/model/continuation, aynı araç dizisinin yeniden kullanımı, signal listener sayısı ve raw-mode restorasyonu | Eski transcript'in TUI'de tekrar çizimi iddia edilmez |
| Terminal yaşam döngüsü | `src/tui/terminal.ts` | İzole POSIX PTY: resize/draft, paste onay koruması, Ctrl+C/Ctrl+D ve SIGINT/SIGTERM/SIGHUP, canonical input restorasyonu | macOS PTY; Terminal.app/iTerm2/Windows Terminal etkileşimli kabulü değil |
| Non-TTY | `src/cli.ts`, terminal renderer | Mevcut `tests/cli/` regresyonları ve composition plain-output CLI yolu | Yeni TUI zorunluluğu yok |

## R02 — MCP advisory değerlendirmesi

`pnpm audit --prod` öncesinde 3 high + 2 moderate raporluyordu; SDK 2.3.0 yükseltmesinden sonra **bilinen açık yok**, exit 0. Audit bir exploit doğrulaması veya bütün uygulamanın güvenli olduğunun kanıtı değildir.

| Advisory | Uygulamadaki yol / değerlendirme |
|---|---|
| GHSA-6qxp-vccf-f47h — OAuth authorization server seçimi | `src/mcp-client.ts` yalnız server/origin kapsamlı statik bearer provider kullanır; interaktif SDK OAuth akışı kurulmaz. Yeni 401 metadata challenge regresyonu yabancı discovery sunucusuna sıfır istek doğrular. |
| GHSA-6prh-2h8m-c8cw — redirect ile header/body aktarımı | Üretim fetch zaten `redirect: "error"` uygular. 301/302/303/307/308 için hedef origin'e sıfır istek ve credential scope kontrolü test edildi. |
| GHSA-jm63-cq47-j5jp — HTTP transport/server paylaşımı | SDK server üretim `src/` ağ yolunda kullanılmıyor; HTTP fixture'lar artık istek başına örnek oluşturur. İki eşzamanlı client'ın sonuç izolasyonu ve biri kapanınca diğerinin çalışması test edildi. |
| GHSA-46jr-4wx8-v453 — server validation bellek tüketimi | SDK server bu depoda test fixture'ları için kullanılır; üretim MCP istemcisinin response/çıktı sınırları korunur. Paket yine düzeltilmiş sürüme yükseltildi; ayrı exploit denemesi yapılmadı. |
| GHSA-rvq5-wwqv-78pq — server bearer audience | Üretim MCP istemcisi native-store bearer göndericisidir; SDK server bearer doğrulama middleware'i üretim yolunda yok. Düzeltilmiş server paketi kullanılır. |

## Çalıştırılan kontroller

| Kontrol | Sonuç |
|---|---|
| CLI/TUI odaklı küme + yeni composition (SDK yükseltmesinden önce) | **193/193**, hata/atlama yok; `dragons-ct03-focused.log` |
| SDK yükseltmesi sonrası MCP/client/runtime/HTTP/stdio kabul kümesi | **50/50**, hata/atlama yok; `dragons-ct03-mcp.log` |
| Son maddi kaynakta `pnpm release:check` | **1728 toplam / 1721 başarılı / 1 hata / 6 atlama**, exit 1; `dragons-ct03-release.log` |
| Başarısızlık nedeniyle composite gate'in erişmediği `pnpm typecheck` | **PASS**, exit 0; üretim + test TypeScript |
| `pnpm verify:package` | **PASS**, exit 0, `PACKAGE_ACCEPTANCE_OK dragons-agent-0.1.0.tgz`; build dahil |
| Son kaynakta `python3 scripts/verify-tui-pty.py` | **10/10**, `M72_PTY_ACCEPTANCE_OK`, `live_provider_inference: false` |
| `pnpm audit --prod`, `git diff --check` | **PASS** |

Tam kümenin tek hatası önceden açık Desktop/Web R01 testidir: `dashboard MCP status is bounded, inert and cleared across reconnects` → `Dashboard state did not settle`. Test değiştirilmedi, silinmedi veya atlanmadı. **Tam `release:check` PASS değildir.** Altı atlama önceki platform dağılımını korur: dört checkpoint platform testi ve iki Linux AppImage worker testi. Loglar yerel Hermes scratch dizinindedir; paket dağıtımına eklenmez.

## Açık sınırlar

- CT03 yerel deterministik coding akışı, Mac izole PTY ve R02 bağımlılık onarımı doğrulandı. İlk üç hedefin güncel CI kanıtı ve gerçek Windows/Linux terminal/OS credential-store/provider kabulü yok.
- `AGENTS.md` yazma engeli korunur; tekrar denenmedi. Yeni tarayıcı, Xcode, terminal framework'ü veya kişisel profil kurulmadı/kullanılmadı.
- CT04 hazır yeteneklerin erişim matrisi ve CT05 üç hedefin nihai teslimat kabulü bu kayıtla kapanmaz. Desktop R01, CT06 sırasında ayrı onarılacak.
- Commit, push, tag veya yayın yapılmadı. Bu belge test edilen kodu değiştirmez.

Sonraki CT04 kaynak ve sonuçları [`terminal-extension-acceptance.md`](terminal-extension-acceptance.md) içindedir; bu CT03 kaydının hash'i ve sayıları geriye dönük değiştirilmez.
