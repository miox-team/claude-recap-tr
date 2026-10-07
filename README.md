# claude-recap-tr

Claude Code bir işi bitirdiğinde ne yaptığını **kısa, Türkçe ve sesli** anlatır. Ses tamamen Mac'inizde üretilir.

```
Kalıcı kurulum için bir komutu sizin çalıştırmanız gerekiyor.
İzin sistemi otomatik kurulumu engelledi.                         [ Sustur ]
```

Uzun bir cevabı okumadan neyin bittiğini, neyin sizi beklediğini duyarsınız. Başka bir pencerede çalışırken bile.

- **Yalnız gereken.** Sizden bir şey isteniyorsa önce onu söyler, sonra tek cümleyle ne olduğunu ve neden olduğunu. En çok 20 kelime. Adımlar, dosya adları, test çıktıları özete girmez.
- **Yerel Türkçe ses.** 8,6 milyon parametrelik [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning) modeli Mac'inizde çalışır. Ses için internete çıkılmaz.
- **Üç durum.** `on` sesli, `mute` yalnız yazı, `off` kapalı. Bu oturum için ya da tüm oturumlar için.
- **Kendi kendini yönetir.** Ses sunucusu gerektiğinde kalkar, 15 dakika boşta kalınca ya da `/recap off hepsi` deyince kapanır.
- **Her an susturulabilir.** Özet prompt'un üstünde yazılı durur, yanında **Sustur** düğmesi vardır. Yeni bir şey yazmaya başlayınca ses kendiliğinden kesilir.

## Kurulum

### Claude Code'a bırakın

Aşağıdaki metni kopyalayıp Claude Code'a yapıştırın. Claude eklentiyi kurar, ses modelini indirip doğrular ve bir deneme cümlesi okutur.

```text
recap eklentisini kur: https://github.com/miox-team/claude-recap-tr

1. Bu bilgisayarın macOS olduğunu kontrol et. Değilse dur ve bana söyle; recap yalnız macOS'ta çalışır.
2. Eklentiyi kur:
   claude plugin marketplace add miox-team/claude-recap-tr
   claude plugin install recap@miox-team --scope user
3. Yerel Türkçe sesi kur. Repoyu geçici bir klasöre klonla. scripts/install_voice.py ve tts/ema_server.py dosyalarını oku ve ne yaptıklarını bana iki cümleyle anlat. Sonra çalıştır:
   python3 scripts/install_voice.py
   Betik uv ister. uv yoksa önce bana sor; onay verirsem brew install uv ile kur (Homebrew yoksa https://docs.astral.sh/uv/ adresindeki resmi kurulumu kullan) ve betiği yeniden çalıştır.
4. Betik sonunda "Recap kuruldu. Sesli özetler hazır." der. Sesi duyup duymadığımı sor.
5. Geçici klasörü sil. Bitince bana /reload-plugins yazmamı ya da Claude Code'u yeniden başlatmamı söyle, sonra /recap ile durumu görebileceğimi anlat.
```

### Elle kurulum

1. Claude Code içinde:
   ```
   /plugin install recap --marketplace miox-team/claude-recap-tr
   ```
2. Terminalde:
   ```
   git clone https://github.com/miox-team/claude-recap-tr
   python3 claude-recap-tr/scripts/install_voice.py
   ```
3. Claude Code içinde `/reload-plugins` yazın ya da Claude Code'u yeniden başlatın.

**Gereksinimler:** macOS, Claude Code (2.1.292 ile denendi), [uv](https://docs.astral.sh/uv/) (`brew install uv`) ve yaklaşık 700 MB disk alanı. Alanın çoğu PyTorch'a gider; ses modelinin kendisi 34 MB.

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
        ▼ özet metni
EMA ses sunucusu (~/.claude/recap/voice.sock)
  · kapalıysa eklenti başlatır
  · 15 dk boşta kalırsa kendini kapatır
        │ WAV
        ▼
afplay ──► hoparlör
```

Eklenti bir Claude Code hooks modülüdür (`hooks/register.tsx`). Ses sunucusu ayrı bir Python sürecidir (`tts/ema_server.py`). Eklenti sunucuyla yalnız sizin erişebildiğiniz bir Unix soketi üzerinden konuşur; ağ portu açılmaz.

## Gizlilik ve güvenlik

- **Özet:** Uzun bir cevabın metni özetlenmek için Claude'a gider. Bu, oturumun zaten konuştuğu yerdir ve sizin Claude Code hesabınızla yapılır. Uzun her cevap için düşük effort'lu bir Claude Sonnet çağrısı yapılır ve kullanım limitinizden düşer. 200 karakterden kısa cevaplar özetlenmeden doğrudan okunur.
- **Ses:** Tamamen yereldir ve internetsiz çalışır. Sunucu ağ portu açmaz; yalnız `~/.claude/recap/` klasöründeki bir Unix soketini dinler. Klasör yalnız sizin erişebileceğiniz izinle (`0700`) oluşturulur, bu yüzden başka kullanıcılar ve web sayfaları sunucuya ulaşamaz.
- **Model dosyaları:** İlk kurulumda Hugging Face'ten bir kez iner. `ema-lightning` paketi bu dosyaları kod çalıştırabilen bir yöntemle (`torch.load(weights_only=False)`) açar. Bu yüzden recap dosyayı bir kez okur, SHA-256 özetini incelenmiş sürümle karşılaştırır ve modeli o aynı baytlardan yükler. Dosya değişmişse yüklemeyi reddeder. Kurulum betiği dosyaları ayrıca güvenli modda (`weights_only=True`) açarak kod içermediklerini doğrular.

## Dosyalar

| Yer | Ne |
|---|---|
| `~/.local/share/recap-ema/` | Ses modelinin Python ortamı |
| `~/.claude/recap/voice.sock` | Ses sunucusunun soketi (yalnız sunucu çalışırken) |
| `~/.claude/recap.json` | Tüm oturumlar için seçilen durum |
| `$TMPDIR/recap-voice-server.log` | Ses sunucusunun günlüğü |

Ağ portu kullanılmadığı için başka bir programla çakışma olmaz.

## Sorun giderme

| Görünen | Sebep ve çözüm |
|---|---|
| `Ses üretilemedi, sesli okunmadı.` | Sunucu başlatılamadı ya da hata verdi. `$TMPDIR/recap-voice-server.log` dosyasına bakın; çoğu zaman `python3 scripts/install_voice.py` yeniden çalıştırmak yeter. |
| `Makine yoğun, sesli okunmadı.` | İşlemci yükü çekirdek başına 2'yi aşınca ses atlanır, özet yazılı kalır. |
| Ne ses ne özet var | `/recap` ile durumu kontrol edin; oturum `mute` ya da `off` olabilir. |
| `refusing to load the model` (günlükte) | Önbellekteki model dosyası incelenen sürümle aynı değil. `python3 scripts/install_voice.py` ile yeniden kurun. |

## Kaldırma

```
claude plugin uninstall recap
rm -rf ~/.local/share/recap-ema ~/.claude/recap ~/.claude/recap.json
rm -rf ~/.cache/huggingface/hub/models--canberkkkkkk--ema-lightning
```

## Geliştirme

```
claude --plugin-dir .            # eklentiyi bu klasörden çalıştır, kaydedince yeniden yüklenir
claude plugin test .             # testler
claude plugin validate .         # manifest, marketplace ve hooks modülü denetimi
```

## Teşekkür

- Ses: [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning), Canberk Aslan, Apache 2.0. Tek seslidir ve Türkçe dışındaki kelimeleri Türkçe yazımla okur.
- Metin normalleştirme: [normalizer-tr](https://github.com/erdemtuna/normalizer-tr).
- EMA'nın model kartındaki gibi: yapay sesle ürettiğiniz kaydı başkalarıyla paylaşırsanız sesin yapay olduğunu belirtin.

## Lisans

[MIT](LICENSE). Bu repo ses modelini içermez; model kurulum sırasında Hugging Face'ten kendi lisansıyla (Apache 2.0) indirilir.
