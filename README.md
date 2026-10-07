# claude-recap-tr

Claude Code bir işi bitirdiğinde ne yaptığını **kısa, Türkçe ve sesli** anlatır. Ses tamamen bilgisayarınızda üretilir. macOS ve Windows'ta çalışır.

```
Kalıcı kurulum için bir komutu sizin çalıştırmanız gerekiyor.
İzin sistemi otomatik kurulumu engelledi.                         [ Sustur ]
```

Uzun bir cevabı okumadan neyin bittiğini, neyin sizi beklediğini duyarsınız. Başka bir pencerede çalışırken bile.

- **Yalnız gereken.** Sizden bir şey isteniyorsa önce onu söyler, sonra tek cümleyle ne olduğunu ve neden olduğunu. En çok 20 kelime. Adımlar, dosya adları, test çıktıları özete girmez.
- **Yerel Türkçe ses.** 8,6 milyon parametrelik [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning) modeli bilgisayarınızda çalışır. Ses için internete çıkılmaz.
- **Üç durum.** `on` sesli, `mute` yalnız yazı, `off` kapalı. Bu oturum için ya da tüm oturumlar için.
- **Kendi kendini yönetir.** Ses sunucusu gerektiğinde kalkar, 15 dakika boşta kalınca ya da `/recap off hepsi` deyince kapanır.
- **Her an susturulabilir.** Özet prompt'un üstünde yazılı durur, yanında **Sustur** düğmesi vardır. Yeni bir şey yazmaya başlayınca ses kesilir.

## Kurulum

### Claude Code'a bırakın

Aşağıdaki metni kopyalayıp Claude Code'a yapıştırın. Claude işletim sisteminize göre doğru yolu seçer, eklentiyi kurar, ses modelini indirip doğrular ve bir deneme cümlesi okutur.

```text
recap eklentisini kur: https://github.com/miox-team/claude-recap-tr

Önce işletim sistemini öğren. macOS ise "macOS yolu"nu, Windows ise (PowerShell ya da cmd; WSL değil) "Windows yolu"nu izle. Başka bir sistemse (Linux, WSL) dur ve bana söyle; recap yalnız macOS ve Windows'ta çalışır.

macOS yolu
1. uv --version ile uv'yi kontrol et. Yoksa önce bana sor; onay verirsem brew install uv ile kur (Homebrew yoksa https://docs.astral.sh/uv/ adresindeki resmi kurulumu kullan).
2. Eklentiyi kur:
   claude plugin marketplace add miox-team/claude-recap-tr
   claude plugin install recap@miox-team --scope user
3. Repoyu geçici bir klasöre klonla. scripts/install_voice.py ve tts/ema_server.py dosyalarını oku, ne yaptıklarını bana iki cümleyle anlat. Sonra repo klasöründe çalıştır:
   uv run --no-project --python 3.12 scripts/install_voice.py

Windows yolu
1. uv --version ile uv'yi kontrol et. Yoksa önce bana sor; onay verirsem winget install --id astral-sh.uv -e ile kur. Kurulumdan sonra uv bu oturumda bulunamazsa %LOCALAPPDATA%\Microsoft\WinGet\Links\uv.exe yolunu kullan.
2. Eklentiyi kur:
   claude plugin marketplace add miox-team/claude-recap-tr
   claude plugin install recap@miox-team --scope user
3. Repoyu geçici bir klasöre klonla. scripts/install_voice.py ve tts/ema_server.py dosyalarını oku, ne yaptıklarını bana iki cümleyle anlat. Sonra repo klasöründe çalıştır:
   uv run --no-project --python 3.12 scripts/install_voice.py
   "PyTorch could not load" ya da c10.dll hatası çıkarsa bana sor; onay verirsem winget install Microsoft.VCRedist.2015+.x64 ile Visual C++ çalışma ortamını kur ve komutu yeniden çalıştır.

İki yolda da sonunda
4. Betik "Recap kuruldu. Sesli özetler hazır." der. Sesi duyup duymadığımı sor.
5. Geçici klasörü sil. Bana /reload-plugins yazmamı ya da Claude Code'u yeniden başlatmamı söyle, sonra /recap ile durumu görebileceğimi anlat.
```

### Elle kurulum

1. [uv](https://docs.astral.sh/uv/) kurun: macOS'ta `brew install uv`, Windows'ta `winget install --id astral-sh.uv -e`.
2. Claude Code içinde:
   ```
   /plugin install recap --marketplace miox-team/claude-recap-tr
   ```
3. Terminalde (macOS'ta Terminal, Windows'ta PowerShell):
   ```
   git clone https://github.com/miox-team/claude-recap-tr
   cd claude-recap-tr
   uv run --no-project --python 3.12 scripts/install_voice.py
   ```
4. Claude Code içinde `/reload-plugins` yazın ya da Claude Code'u yeniden başlatın.

**Gereksinimler:** macOS ya da Windows 10 (1803 ve sonrası) / 11, Claude Code (2.1.292 ile denendi), uv ve yaklaşık 1 GB disk alanı. Alanın çoğu PyTorch'a gider; ses modelinin kendisi 34 MB. Windows'ta Visual C++ çalışma ortamı da gerekir; çoğu bilgisayarda zaten vardır.

> **Windows desteği yeni.** Ses sunucusu ve kurulum her değişiklikte GitHub Actions'ta gerçek bir Windows makinesinde sınanıyor. Claude Code içinden gerçek bir Windows'ta henüz denenmedi; denerseniz sonucu bir issue ile yazın.

## Kullanım

| Komut | Ne olur |
|---|---|
| `/recap` | Durumu gösterir, hiçbir şeyi değiştirmez. |
| `/recap on` | Bu oturumda özet sesli okunur. |
| `/recap mute` | Bu oturumda özet yazılır, ses yok. |
| `/recap off` | Bu oturumda özet yok. |
| `/recap off hepsi` | Tüm oturumlarda özet yok; ses sunucusu da kapanır. |

Türkçe kelimeler de çalışır: `aç`, `sessiz`, `kapat`, `durum`. Tüm oturumlar için sonuna `hepsi` ya da `heryerde` ekleyin.

**Son verilen komut geçerlidir.** `/recap off hepsi` dedikten sonra bir oturumda `/recap on` derseniz yalnız o oturum yeniden konuşur. Her cevap aynı kalıpta gelir:

```
Bu oturum artık mute — özet yazılır, ses yok.
Diğer oturumlar on — özet sesli okunur.
```

Ses kapalıyken durum çubuğunda `recap: mute` ya da `recap: off` görünür.

## Nasıl çalışır

```
Claude cevabını bitirir
        │
        ▼
recap eklentisi ── cevap uzunsa ──► Claude Sonnet: eylem + neden-sonuç, en çok 20 kelime
        │
        ▼ "oku", "sus", "kapan"
EMA ses sunucusu
  · kapalıysa eklenti başlatır, 15 dk boşta kalırsa kendini kapatır
  · sentezler ve çalar: macOS'ta afplay, Windows'ta winsound
        │
        ▼
hoparlör
```

Eklenti bir Claude Code hooks modülüdür (`hooks/register.tsx`) ve işletim sistemine özgü hiçbir komut çalıştırmaz; sunucuya yalnız `curl` ile "oku", "sus" ve "kapan" der. Sentez, çalma, durdurma ve işlemci yükü denetimi ayrı bir Python sürecinde (`tts/ema_server.py`) yapılır.

## Gizlilik ve güvenlik

- **Özet:** Uzun bir cevabın metni özetlenmek için Claude'a gider. Bu, oturumun zaten konuştuğu yerdir ve sizin Claude Code hesabınızla yapılır. Uzun her cevap için düşük effort'lu bir Claude Sonnet çağrısı yapılır ve kullanım limitinizden düşer. 200 karakterden kısa cevaplar özetlenmeden doğrudan okunur.
- **Ses:** Tamamen yereldir ve internetsiz çalışır.
  - **macOS:** Sunucu ağ portu açmaz; yalnız `~/.claude/recap/` klasöründeki bir Unix soketini dinler. Klasör yalnız sizin erişebileceğiniz izinle (`0700`) oluşturulur; başka kullanıcılar ve web sayfaları sunucuya ulaşamaz.
  - **Windows:** Windows'taki Python Unix soketini desteklemediği için sunucu yalnız `127.0.0.1` üzerinde, her başlatmada işletim sisteminin seçtiği rastgele bir portta dinler. Port, her başlatmada yenilenen gizli bir jeton ve sunucunun kendini tanıttığı bir kanıt değeri, yalnız sizin profil klasörünüzdeki `~/.claude/recap/voice.json` dosyasına yazılır. Jetonsuz istekler reddedilir; web sayfaları ve başka kullanıcılar bu dosyayı okuyamadığı için sunucuyu kullanamaz. Kalan küçük risk: sunucu çöker ve aynı bilgisayardaki başka bir kullanıcının programı tam o porta yerleşirse, eklenti bunu fark edip sunucuyu yeniden başlatana kadar en çok bir özet o programa gidebilir.
- **Model dosyaları:** İlk kurulumda Hugging Face'ten bir kez iner. `ema-lightning` paketi bu dosyaları kod çalıştırabilen bir yöntemle (`torch.load(weights_only=False)`) açar. Bu yüzden recap dosyayı bir kez okur, SHA-256 özetini incelenmiş sürümle karşılaştırır ve modeli o aynı baytlardan yükler. Dosya değişmişse yüklemeyi reddeder. Kurulum betiği dosyaları ayrıca güvenli modda (`weights_only=True`) açarak kod içermediklerini doğrular.

## Dosyalar

`~`, macOS'ta ev klasörünüz, Windows'ta `%USERPROFILE%`.

| Yer | Ne |
|---|---|
| `~/.local/share/recap-ema/` | Ses modelinin Python ortamı |
| `~/.claude/recap/voice.sock` | macOS: ses sunucusunun soketi (yalnız sunucu çalışırken) |
| `~/.claude/recap/voice.json` | Windows: sunucunun portu, jetonu ve kanıtı (yalnız sunucu çalışırken) |
| `~/.claude/recap.json` | Tüm oturumlar için seçilen durum |
| `recap-voice-server.log` | Ses sunucusunun günlüğü; macOS'ta `$TMPDIR`, Windows'ta `%TEMP%` içinde |

## Sorun giderme

| Görünen | Sebep ve çözüm |
|---|---|
| `Ses üretilemedi, sesli okunmadı.` | Sunucu başlatılamadı ya da hata verdi. `recap-voice-server.log` dosyasına bakın; çoğu zaman kurulum komutunu (`uv run --no-project --python 3.12 scripts/install_voice.py`) yeniden çalıştırmak yeter. |
| `Makine yoğun, sesli okunmadı.` | macOS'ta işlemci yükü çekirdek başına 2'yi aşınca ses atlanır, özet yazılı kalır. |
| Ne ses ne özet var | `/recap` ile durumu kontrol edin; oturum `mute` ya da `off` olabilir. |
| `refusing to load the model` (günlükte) | Önbellekteki model dosyası incelenen sürümle aynı değil. Kurulum komutunu yeniden çalıştırın. |
| Windows: `PyTorch could not load`, `c10.dll` | Visual C++ çalışma ortamı eksik: `winget install Microsoft.VCRedist.2015+.x64`. |
| Windows: `uv` bulunamıyor | winget'ten sonra açık pencereler yeni PATH'i görmez. Yeni bir pencere açın ya da `%LOCALAPPDATA%\Microsoft\WinGet\Links\uv.exe` yolunu kullanın. |

## Kaldırma

```
claude plugin uninstall recap
```

macOS:

```
rm -rf ~/.local/share/recap-ema ~/.claude/recap ~/.claude/recap.json
rm -rf ~/.cache/huggingface/hub/models--canberkkkkkk--ema-lightning
```

Windows (PowerShell):

```
Remove-Item -Recurse -Force "$HOME\.local\share\recap-ema", "$HOME\.claude\recap", "$HOME\.claude\recap.json"
Remove-Item -Recurse -Force "$HOME\.cache\huggingface\hub\models--canberkkkkkk--ema-lightning"
```

## Geliştirme

```
claude --plugin-dir .            # eklentiyi bu klasörden çalıştır, kaydedince yeniden yüklenir
claude plugin test .             # eklenti testleri
claude plugin validate .         # manifest, marketplace ve hooks modülü denetimi
uv run --no-project --python 3.12 scripts/check_voice_server.py   # gerçek ses sunucusu kontrolleri
```

Her push'ta GitHub Actions kurulumu ve ses sunucusu kontrollerini Windows ve macOS'ta koşar (`.github/workflows/voice.yml`).

## Teşekkür

- Ses: [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning), Canberk Aslan, Apache 2.0. Tek seslidir ve Türkçe dışındaki kelimeleri Türkçe yazımla okur.
- Metin normalleştirme: [normalizer-tr](https://github.com/erdemtuna/normalizer-tr).
- EMA'nın model kartındaki gibi: yapay sesle ürettiğiniz kaydı başkalarıyla paylaşırsanız sesin yapay olduğunu belirtin.

## Lisans

[MIT](LICENSE). Bu repo ses modelini içermez; model kurulum sırasında Hugging Face'ten kendi lisansıyla (Apache 2.0) indirilir.
