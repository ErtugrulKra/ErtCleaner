# CLI kipi

ErtCleaner arayüz açmadan komut satırından çalışabilir.

## Kullanım

```
ertcleaner --cli [seçenekler] [kategoriler...]
```

## Kategoriler

| Bayrak | Açıklama |
|------|-------------|
| `--system` | Sistem geçici dosyaları, önbellekler, günlükler |
| `--browser` | Tarayıcı önbellekleri |
| `--app` | Uygulama önbellekleri |
| `--gaming` | Oyun başlatıcı / GPU önbellekleri |
| `--recycle-bin` | Geri Dönüşüm Kutusu |
| `--all` | Tüm kategoriler (varsayılan) |

## Seçenekler

| Bayrak | Açıklama |
|------|-------------|
| `--clean` | Taradıktan sonra bulunan öğeleri sil |
| `--json` | JSON çıktı |
| `--verbose` | Ayrıntılı ilerleme |
| `-q`, `--quiet` | Yalnızca hatalar ve sonuç |
| `-h`, `--help` | Yardım |
| `-v`, `--version` | Sürüm |

## Örnekler

```bash
# Kuru tarama — hiçbir şey silinmez
ertcleaner --cli

# Sistem ve tarayıcı önbelleğini temizle
ertcleaner --cli --clean --system --browser
```

`--clean` olmadan yalnızca tarama yapılır; silme işlemi yapılmaz.
