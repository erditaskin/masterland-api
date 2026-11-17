# Masterland API

Masterland'e özel Fastify 5/PostgreSQL API. Oyun çevrimdışı kalır; API kimlik, bulut revizyonu, doğrulanmış reklam ödülü ve hesap silmeyi yönetir. Soruders'in Fastify/Zod, hash'li oturum, Docker/Nginx ve sürümlü deployment prensiplerini izler. MongoDB, e-posta servisi veya multiplayer içermez.

## Geliştirme

Node 24.22.1 ve pnpm 10.28.0 kullanılır. Ortam örneği `.env.example` içindedir. Runtime `process.env` kullanır; yerel çalıştırmada ortamı güvenli biçimde sağlayın. Secret değerlerini source, log veya mobil bundle'a yazmayın.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Testler gerçek PostgreSQL gerektirir: `NODE_ENV=test`, `DATABASE_URL` ve `masterland_test*` adlı izole DB ile `pnpm test`. Production DB ile test çalışmaz. Şema `pnpm db:generate` ile üretilir; `pnpm db:migrate` ayrı operatör işlemidir. Migration startup/deployment'a gömülmez. Tüm bağlantılar `masterland_*` isim sınırını doğrular.

## Sunucu

API `https://api.masterland.app`, web `https://masterland.app`; VPS `142.93.88.194`. Soruders farklı sunucudadır. Yerel API `/Users/erdi/masterland/masterland-api`; mobil Expo kökü `/Users/erdi/masterland/masterland-mobile/mobile`; web `/Users/erdi/masterland/masterland-web` altındadır.

VPS 458 MB RAM taşır. Build yerelde Linux/amd64 yapılır. API UID10001, read-only filesystem, cap_drop ALL, no-new-privileges ve 160 MB sınırıyla çalışır. PostgreSQL dış port yayınlamaz, ayrı ağda ve 128 MB sınırındadır. 1 GB swap vardır. Runtime DB rolü DML ile sınırlıdır; migration ayrı admin kimliği kullanır.

`/opt/masterland/env` 0700, env dosyaları 0600; Apple key servis kullanıcısına ait 0400 dosyadır. Docker build context tüm env/secret dosyalarını dışlar. Kaynak ve image kimlikleri release manifestinde tutulur. Docker export/import katmanları ve runtime config'i doğrulanır; Docker sürümlerinin null default normalizasyonu image ID'yi değiştirebilir.

```sh
masterland-deploy status
masterland-deploy activate RELEASE
masterland-deploy rollback
```

Nginx query parametrelerini loglamaz, forwarded IP'yi yeniden oluşturur. Cloudflare IP güveni yalnız resmi ağ aralıklarına aittir. TLS yenilemesi `certbot.timer` ile yapılır. `masterland-backup.timer` her gün UTC03:15 civarında custom PostgreSQL dump alır; arşiv listesi ve SHA-256 doğrulanır. Aynı sunucudaki yedek, sunucu kaybına karşı bağımsız bir yedek değildir. Offsite hedef ve yayın sonrası saklama politikası ayrıca tamamlanmalıdır; bu geçiş otomatik yedek silmez.

Deployment bildirimleri yalnız Masterland webhook'una gider. Soruders dosyaları, verileri ve bildirim kanalı değiştirilmez. API200 ve birim testi, gerçek cihaz/sağlayıcı/reklam/silme kabulü değildir. Güncel kapsam `docs/contracts.md` ve mobil depodaki `docs/vps-migration-20261117.md` içindedir.
