<p align="center">
  <img src="logo.png" alt="ErtCleaner" width="128" height="128">
</p>

**Türkçe** | [English](README.EN.md)

# ErtCleaner

Windows için modern, açık kaynak sistem temizleyici.

[![CI](https://github.com/ErtugrulKra/ErtCleaner/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ErtugrulKra/ErtCleaner/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ErtugrulKra/ErtCleaner)](https://github.com/ErtugrulKra/ErtCleaner/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Yalnızca **Windows x64** hedeflenir. Arayüz **Türkçedir**. Tarama, temizlik, geçmiş ve ayarlar **bu bilgisayarda** kalır; çekirdek işlemler için bulut servisi yoktur. Kurulum yönetici yetkisi ister ve uygulamayı Program Files altına yerleştirir.

Uygulamayı **yalnızca resmi [GitHub Releases](https://github.com/ErtugrulKra/ErtCleaner/releases)** üzerinden indirin. ErtCleaner yükseltilmiş (yönetici) çalışır. Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md).

## İndirme ve kurulum

1. [Son sürümü](https://github.com/ErtugrulKra/ErtCleaner/releases/latest) açın.
2. `ErtCleaner-Setup-{sürüm}.exe` dosyasını indirin. İsterseniz yanındaki `.sha256` dosyasıyla bütünlüğü doğrulayın.
3. Kurulumu çalıştırın. UAC yükseltmesi istenir; kurulum **makine genelidir** (Program Files).

GitHub Release paketleri **imzasızdır**. Windows SmartScreen “tanınmayan yayıncı” uyarısı gösterebilir. Kaynak açıktır; checksum ile indirdiğiniz dosyanın Release’tekiyle aynı olduğunu doğrulayın.

Uygulama içi otomatik güncelleme **kapalıdır**. Yeni sürüme geçmek için yine GitHub Releases’ten kurulum paketini indirin.

## Kaldırma

- **Windows Ayarları:** Ayarlar → Uygulamalar → Yüklü uygulamalar → ErtCleaner → Kaldır.
- **NSIS kaldırıcı:** `C:\Program Files\ErtCleaner\Uninstall ErtCleaner.exe` (electron-builder `productName: ErtCleaner`, `perMachine: true`).

Kurulum, `deleteAppDataOnUninstall: false` ile yerel uygulama verisini silmez. Paketlenmiş uygulama verisi Electron `userData` yoludur: `%APPDATA%\ErtCleaner`. Geliştirme oturumları `%APPDATA%\ErtCleaner\ErtCleaner-Dev` kullanabilir. `--ertcleaner-data-dir=` ile özel bir dizin verilmişse o yol geçerlidir.

## Ne yapar, ne yapmaz

ErtCleaner disk, kayıt defteri, servisler ve Windows ayarları üzerinde çalışır. Çoğu işlem geri alınabilir yedek, sistem geri yükleme noktası, karantina veya anlık görüntü ile korunur; yine de yönetici olarak çalıştığı için seçiminizi tarama sonuçlarından yapın.

Yapmaz:

- Windows Defender’ı tarama motoru olarak çağırmaz. Kötü amaçlı yazılım taraması yerel sezgisel analiz ve kalıcılık kontrolüdür.
- Uzak zafiyet, açık port veya parola taraması yapmaz; uzaktan yönetim ajanı değildir.
- Uygulamayı kendi kendine güncellemez.
- Telemetri göndermez; temizlik ve tarama sonuçlarını uzak bir sunucuya yüklemez.

## Fonksiyonlar

Kenar çubuğundaki gruplara göre. Her araç önce tarar (veya listeler); silme ve değişiklik sizin onayınızla olur.

### Temizlik

**Ana sayfa.** Disk kullanımı, hafif CPU/RAM özeti ve bir sağlık skoru gösterir. Tek tık temizlik, seçtiğiniz temizleyici kategorilerini, kayıt defteri onarımını, kötü amaçlı yazılım taramasını ve gizlilik taramasını sırayla çalıştırır. İlk açılışta kısa bir kurulum sihirbazı (başlangıç, tepsi, haftalık bakım) çıkar.

**Sistem temizleyici.** JSON kuralları (`rules/win32/`) ile sistem, tarayıcı, uygulama, oyun, GPU önbelleği, Geri Dönüşüm Kutusu, bozuk kısayollar, ortam değişkenleri ve SQLite veritabanı adaylarını tarar. Öğeleri seçip silersiniz. İsteğe bağlı sistem geri yükleme noktası, güvenli silme ve dışlama listesi vardır.

**Kayıt defteri.** Yetim, kopuk ve geçersiz girdilerin yanı sıra güvenlik sapmalarını (UAC kapalı, Defender kapalı, güvenlik duvarı kapalı, AutoRun) arar. Onarım seçilen anahtarlara uygulanır; isteğe bağlı `.reg` yedeği alınır.

**Başlangıç.** Run anahtarları, başlangıç klasörleri ve zamanlanmış görevlerdeki öğeleri listeler. Açma, kapama ve silme desteklenir. Olay Günlüğü’nden önyükleme izi gösterilebilir.

**Ağ.** DNS önbelleği, Wi‑Fi profilleri, ARP önbelleği ve kayıtlı ağ profillerini tarayıp seçilenleri temizler.

**Otomatik bakım.** En fazla 10 zamanlanmış iş (günlük / haftalık / aylık). Temizleyici alt görevleri, kayıt defteri onarımı, sürücü ve yazılım güncellemeleri planlanabilir. Zamanı gelince masaüstü bildirimi çıkar.

### Koruma

**Kötü amaçlı yazılım.** Yerel çok aşamalı tarama: PE ve betik sezgiseli, hosts dosyası müdahalesi, Run anahtarları ve zamanlanmış görevlerde kalıcılık. Bulunanlar karantinaya alınabilir, silinebilir veya izin listesine eklenebilir. İmza bulutu ve Windows Defender entegrasyonu yoktur.

**Gizlilik kalkanı.** Telemetri, reklam, arama, eşitleme ve Windows AI ile ilgili kayıt defteri / zamanlanmış görev ayarlarını puanlar ve önerilenleri uygular. Ayarlar bu makinede değiştirilir; veri dışarı gönderilmez.

**Güvenlik duvarı denetimi.** Kullanıcı güvenlik duvarı kurallarını tarar: bayat, imzasız veya gereksiz geniş kurallar. Toplu kapatma ve silme yapılabilir.

### Performans

**Canlı performans.** CPU, RAM ve disk grafikleri, süreç tablosu (sonlandırma) ve disk S.M.A.R.T. sağlığı.

**Servisler.** Windows servislerini güvenlik notuyla listeler. Durdurma / başlatma bağımlılıkları hesaba katar; kritik servislerde uyarır.

### Yazılım

**Yazılım güncellemeleri.** Kurulu uygulamaları **winget** üzerinden kontrol eder ve günceller. Chocolatey, Scoop ve npm varsa yedek kaynak olarak kullanılabilir.

**Sürücü güncellemeleri.** `pnputil` ile eski sürücü paketlerini tarayıp kaldırır; Windows Update üzerinden sürücü güncellemesi denetler ve kurar.

**Kaldırma.** Kurulu programları listeler, kendi kaldırıcısını çalıştırır, ardından kalan dosya, klasör ve kayıt defteri izlerini tarayıp temizleyebilir.

**Bloatware.** Bilinen Microsoft / OEM UWP paketlerini tespit eder ve `Remove-AppxPackage` ile kaldırır.

**Sağ tık menüsü.** Gezgin içerik menüsündeki üçüncü parti işleyicileri (ör. arşiv, bulut, Git) listeler. Kapatma, açma ve silme kayıt defteri üzerinden yapılır.

### Depolama

**Depolama özeti.** Sürücü listesi, klasör treemap’i ve dosya türü dağılımı.

**Yinelenen dosyalar.** İçerik karmasına göre kopyaları bulur; boyut ve uzantı süzgeçleri vardır. Hangisinin silineceğine siz karar verirsiniz.

**Büyük dosyalar.** Seçilen dizinde eşik üstü dosyaları listeler.

**Boş klasörler.** Boş dizinleri bulur; isteğe bağlı siler.

**Dosya parçalayıcı.** 2 geçişli üzerine yazma (rastgele + sıfır). Sistem ve profil kökleri korumalıdır; yanlışlıkla Windows dizinini parçalamayı reddeder.

**Disk onarım.** **SFC**, **DISM** ve **CHKDSK** çalıştırır; ilerleme canlı gösterilir. Yönetici gerekir.

**Disk bakımı.** SSD / NVMe sürücülerde TRIM durumunu gösterir ve toplu TRIM uygular.

### Oyun modu

Oyuna geçmeden önce servisleri durdurma, süreç sonlandırma, beklemedeki RAM’i boşaltma, güç planı, Game Bar / DVR ve ilgili ağ ince ayarlarının **anlık görüntüsünü** alır. Oturum bitince geri yüklenir. İsteğe bağlı oyun algılama vardır.

### Etkinlik ve ayarlar

**Etkinlik.** Yapılan işlemlerin zaman çizelgesi ve grafikleri. Silme günlüğü CSV olarak dışa aktarılabilir.

**Ayarlar.** Tema, tepsi, başlangıç görevi, bildirimler, temizleyici tercihleri, dışlama listesi, yedek klasörü ve yedekleme kipi.

**Hakkında.** Sürüm ve lisans. Uygulama güncelleme kontrolü arayüzde durur; arka uç şu an güncelleme indirmez.

## Komut satırı

Kurulu uygulama başsız çalıştırılabilir:

```text
ErtCleaner.exe --cli <komut> [alt komut] [seçenekler]
```

Geliştirme ortamında aynı bayrak `npm run dev` yerine paketlenmiş ikili üzerinde kullanılır.

| Komut | Ne işe yarar |
| --- | --- |
| `scan` / `clean` | Dosya temizleyicileri (`--system`, `--browser`, `--app`, `--gaming`, `--recycle-bin`, `--all`) |
| `registry scan` / `fix` | Kayıt defteri tarama ve onarım |
| `startup list` / `disable` / `enable` / `delete` | Başlangıç öğeleri; `boot-trace` önyükleme izi |
| `debloat scan` / `remove` | Bloatware |
| `disk drives` / `analyze` / `file-types` | Disk kullanımı |
| `network scan` / `clean` | Ağ önbelleği ve profiller |
| `malware scan` / `quarantine` / `delete` | Yerel tehdit taraması |
| `privacy scan` / `apply` | Gizlilik ayarları |
| `drivers scan` / `clean` / `check-updates` / `update` | Sürücü paketleri |
| `services scan` / `disable` / `enable` / `manual` / `auto` | Windows servisleri |
| `programs list` | Kurulu programlar |
| `updates check` / `run` | winget güncellemeleri |
| `perf info` / `disk-health` / `kill` | Performans ve süreç |
| `leftovers scan` / `clean` | Kaldırma artıkları |
| `history list` / `clear` | İşlem geçmişi |
| `restore-point create` | Sistem geri yükleme noktası |
| `config get` / `set` | Yerel ayarlar |

Yararlı genel bayraklar: `--json`, `--verbose`, `-q` / `--quiet`, `--all`, `-h`, `-v`.

Örnekler:

```text
ErtCleaner.exe --cli scan --all --clean
ErtCleaner.exe --cli registry scan --json
ErtCleaner.exe --cli malware scan
```


## Lisans

MIT. Telif bilgileri [LICENSE](LICENSE) dosyasındadır. Üçüncü parti bileşenler: [docs/third-party-components.md](docs/third-party-components.md).
