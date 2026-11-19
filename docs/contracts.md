# Masterland API sözleşmesi

## Kimlik

Apple/Google/Facebook girişleri vardır; e-posta giriş/doğrulama yoktur. Provider + subject tek kimlik anahtarıdır. Aynı e-posta hesapları birleştirmez. Opaque 256-bit token mobil SecureStore'a, yalnız SHA-256 hash'i DB'ye yazılır. Oturum 30 gündür; aktif kullanımda beş dakikada bir kayar. Cookie oturum otoritesi değildir. `x-masterland-owner`, Bearer ile doğrulanan owner'a eşit olmak zorundadır; başlık tek başına yetki vermez.

`POST /v1/auth/guest` yalnız açık reklam seçimi sırasında çağrılır. Hesapsız oyun açılması API hesabı oluşturmaz. Yeni provider kimliği guest'i aynı ID ile yükseltir. Mevcut provider hesabına girişte iki kayıt korunur; mobil açık kayıt seçimini gösterir. Bakiyeler toplanmaz.

Apple challenge'ı sunucu üretir; session'a bağlı, beş dakikalık ve tek kullanımlıdır. Native SHA-256 nonce; JWKS imzası, issuer, native Bundle ID audience ve token zamanı doğrulanır. İlk izinde ayrı dönen Apple adı yalnız profil metnidir.

Google/Facebook sistem auth tarayıcısı kullanır. Attempt: state hash'i, istemci PKCE S256, nonce/provider verifier ve başlangıç session'ı ile bağlanır. Google JWT'si JWKS/issuer/audience/nonce ile doğrulanır. Facebook code app secret ile değiştirilir; debug_token ve /me doğru app/user eşleşmesini doğrular. Native callback token taşımaz; iki dakikalık tek kullanımlı code, state ve verifier API'de değiştirilir. İptal yerel/guest ilerlemesini değiştirmez. Reauthentication başka hesabı mevcut hesaba dönüştüremez.

| İşlem | Yol |
|---|---|
| Misafir | `POST /v1/auth/guest` |
| Kullanıcı/çıkış | `GET /v1/auth/me`, `POST /v1/auth/logout` |
| Apple | `POST /v1/auth/apple/challenge`, `POST /v1/auth/apple` |
| OAuth | `POST /v1/auth/oauth/start`, `POST /v1/auth/oauth/exchange` |
| Google callback | `GET /v1/auth/google/callback` |
| Facebook callback | `GET /v1/auth/facebook/callback` |

## Kayıt

`GET /v1/save` owner kaydını döndürür. `PUT /v1/save` body: expected_revision, request_id, save_payload. Mobil schema2 ve dış zarf schema_version1 korunur. TestOnly, bozuk envanter ve geçersiz içerik kimlikleri reddedilir. Çevrimdışı ekonomi her hamle için sunucuda yeniden oynatılmaz; bu kayıt sözleşmesi canlı satın alma bakiyesine otorite vermez.

Owner advisory lock transaction'ı ilk insert dahil CAS'ı serileştirir. Tam aynı request ID/içerik tekrarı aynı revizyonu verir; değiştirilmiş içerik idempotency_mismatch409 alır. Çakışma güncel revizyonu döndürür. Son on eski snapshot korunur. Mobil beş saniyelik toplu yükleme, kalıcı tek uçuşlu outbox, yerel yedek ve hesap değişim korumalarını sürdürür. Her merge ağ isteği yapmaz.

## Reklam

`POST /v1/rewards/prepare`, `POST /v1/rewards/redeem`, `GET /v1/rewards/pending`, `GET /v1/rewards/:intentID`; SSV `GET /v1/admob/ssv`.

Enerji +25; üretici ödülü yalnız sunucuda bağlanmış hedef üreticiyi 80 kullanım/readyAt0 yapar. İki tür ortak günlük dört doğrulanmış ödül sınırını UTC günüyle kullanır. Intent owner/session/tür/şehir/üreticiye bağlıdır. Cihazlar aynı pending intent'i paylaşmaz. Aktif intent'ler geçici kota rezervasyonu oluşturur; süre15 dakika, callback olay zamanı toleransı ±5 dakikadır. Rezervasyon ödeme değildir. `POST /v1/rewards/:intentID/cancel` yalnız aynı owner/session rezervasyonunu bırakır; intent metadata’sı korunur. İptal, bekleyen kotayı serbest bırakır; geç gelen geçerli imzalı earned callback’i kaybolmaz. Gerçek cihaz iptal davranışı ayrıca kabul edilmelidir.

ECDSA imzası orijinal kodlanmış query byte'larıyla doğrulanır. Ad unit/miktar/tür/zaman ayrıca kontrol edilir. Keys kısa süre cache'lenir; key servisi hatası retry edilebilir503'tür. Kapalı SSV'de konsol testleri yalnız imza doğrular, ledger yazmaz. Transaction/intent eşsizliği ve owner transaction'ı tek ödeme sağlar. CAS hatası entitlement tüketmez. Logout pending ödülü silmez; silinmiş kullanıcı callback'i kullanıcı oluşturmaz. SDK earned tek başına ödeme otoritesi değildir.

Varsayılan `ADMOB_SSV_ENABLED=false` kalır. Kullanıcının 17 Kasım 2026 tarihli açık canlı uçtan uca test talebiyle VPS kapısı açılmıştır. Fiziksel +25 ve arka plan kurtarması; gerçek Google imzalı üretici/enerji ödemesi, ortak kota ve temiz Release simülatörde terk etmede sıfır ödeme kabulü tamamlanmıştır. Kanıt mobil depodaki `docs/live-reward-acceptance-20261117.md` içindedir. Mobil doğrulanmış ödül yolu yalnız açık build bayrağıyla production veya kontrollü acceptance kanalında açılır. SDK earned callback’i hiçbir kanalda sunucu imzasının yerine geçmez.

## Silme

`POST /v1/account/deletion` geçerli oturum, DELETE onayı, kalıcı request_id ve 256 bit receipt ister. Geçerli Masterland oturumu, kayıtlı ve misafir hesaplarda yeterlidir. İşlem Masterland oturumlarını, sağlayıcı kimliği eşlemelerini, cihazları, bulut kayıtlarını ve bunlara bağlı kayıtları kaldırır. Kullanıcı satırı kişisel bilgileri temizlenmiş ve `deleted=true` olarak saklanır. Sağlayıcı yetkisi iptal edilmez. Aynı sağlayıcıyla yeniden giriş yeni bir Masterland hesabı oluşturur.

Normalleştirilmiş `users.email` ve `deleted` birlikte benzersizdir. Aynı e-postayı bildiren farklı sağlayıcı kimlikleri birbirine bağlanmaz. Benzersiz anahtar yalnızca bir hesapta tutulur ve diğer hesaplar görüntüleme e-postasını `provider_email` üzerinden korur.

Yeni istemci tek silme isteği gönderir. API, hesap verileri ile silme işaretini tek veritabanı işleminde günceller. Yerel oyun eşleşen `auth_deleted=true` sonucuyla sıfırlanır ve Hesap sayfası giriş seçeneklerini gösterir. `POST /v1/account/deletion/status` eski istemciler için aynı request_id ve receipt ile çalışmaya devam eder.

Misafir ve kayıtlı oturum açma istekleri ile `GET /v1/auth/me` varsa `x-masterland-device-id` ve `x-masterland-device-os` başlıklarını birlikte doğrular. Uygulama kurulumu için üretilen UUID, cihaz işletim sistemi ve son görülme zamanı doğrulanmış kullanıcı kimliğine bağlanır. Eski istemciler cihaz başlıkları olmadan çalışmaya devam eder.

## Güvenlik ve sınırlar

Hata zarfı `{ error: { code, requestId } }`. Route input/output şemaları,120/dakika genel ve10/dakika auth sınırı,1MB body, tek proxy hop'u, helmet/CORS ve no-store uygulanır. Query, provider cevabı ve DB query parametreleri loglanmaz. DML rolü schema değiştiremez. Secret mobil pakete girmez.

Supabase veri/UID taşıması, MongoDB, e-posta servisi, multiplayer, yeni içerik, canlı IAP ve yeni Sentry kurulumu kapsam dışıdır.
