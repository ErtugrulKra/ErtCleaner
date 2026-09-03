# Agents

Bu kod tabanında çalışan tüm yapay zeka alt ajanları (Claude Code ajanları, worktree ajanları vb.) için yönergeler.

ErtCleaner, Windows için Electron tabanlı bir sistem temizleyicidir. 

## Commit Kuralları

Her zaman [Conventional Commits](https://www.conventionalcommits.org/) kullanın. Biçim:

```
<type>(<scope>): <kısa özet>
```

Türler: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

Kırıcı değişiklikler tür/kapsamdan sonra `!` içermelidir.

## Commit Öncesi

- Tüm testlerin geçtiğinden emin olmak için `npm test` çalıştırın.
- Kural JSON dosyaları değiştiyse `npm run validate:rules` çalıştırın.

## Kod Stili

- Kod tabanındaki mevcut kalıpları izleyin.
- PR'ları odaklı tutun — dal başına bir mantıksal değişiklik.

## Verimli Depo Keşfi

- Doğruluğu koruyun: kanıt bulmak için odaklı aramalar kullanın, ardından davranışı anlamak için yeterince çevre kod okuyun.
- Adayları `rg --files` veya `fd` ile listeleyin; özyinelemeli `ls` ve sınırsız dizin dökümlerinden kaçının.
- `rg -n -C 2` ve `-g` süzgeçleriyle arayın. Büyük dosyaların tamamını basmak yerine hedefli aralıkları `sed -n 'START,ENDp'` ile okuyun.
- Dil ayrıştırıcısı uygulandığında sözdizimi farkında aramalar ve yeniden düzenlemeler için `ast-grep` kullanın. Her yeniden yazımı `git diff` ile gözden geçirin.
- Özlü depo, JSON ve YAML özetleri için `tokei --compact`, `jq` ve `yq` kullanın.
- Değişiklik incelemesine `git diff --stat` veya `git status --short` ile başlayın, ardından yalnızca ilgili yolları inceleyin.
- Görev özellikle gerektirmedikçe `node_modules`, üretilmiş varlıklar, kilit dosyaları veya derleme çıktısını taramayın.
