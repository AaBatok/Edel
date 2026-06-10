# 🤖 Edel Runway Desk - Auto Vote Bot

Bot otomatis untuk daily vote pada **Listing Calls** di [Edel Finance Runway Desk](https://runway.edel.finance/listing-calls).

## ✨ Features

- **Auto Vote** setiap 1 jam (configurable via cron)
- **Smart Voting** - analisa data vote untuk pilih asset terbaik (momentum strategy)
- **Telegram Notifications** - notif ke bot Telegram setiap vote berhasil/gagal
- **Session Persistence** - login manual 1x, session disimpan untuk reuse
- **Retry Logic** - exponential backoff jika gagal
- **Screenshot** - bukti setiap vote tersimpan
- **VPS Ready** - jalan headless + PM2 support

> ⚠️ **SECURITY**: JANGAN pernah commit file `.env` atau folder `sessions/` ke repo ini!
> File tersebut berisi token & session login kamu.

## 📋 Prerequisites

- **Node.js v18+** → [Download](https://nodejs.org/)
- **Akun Runway Desk** → [Register](https://runway.edel.finance/register)
- **Passkey** sudah di-setup (Windows Hello / fingerprint / security key)

### VPS (Linux Ubuntu/Debian)
```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2
```

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/AaBatok/Edel.git
cd Edel
npm install
npx playwright install chromium
npx playwright install-deps chromium   # Linux only - install system deps
```

### 2. Configure

```bash
cp .env.example .env
nano .env    # Edit konfigurasi
```

**Isi yang WAJIB diisi di `.env`:**
```env
# Telegram Bot (opsional tapi direkomendasikan)
TELEGRAM_BOT_TOKEN=123456:ABC-xyz...
TELEGRAM_CHAT_ID=987654321
```

### 3. Setup Telegram Bot (Opsional tapi Direkomendasikan)

1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot` → ikuti instruksi → dapat **Bot Token**
3. Buka bot kamu, kirim pesan apa saja (misal: "hello")
4. Buka di browser: `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. Cari `"chat":{"id": 123456789}` → itu **Chat ID** kamu
6. Masukkan keduanya ke `.env`

### 4. Login Setup (1x saja)

```bash
npm run setup
```

> ⚠️ **PENTING**: Ini akan membuka browser (butuh GUI/Desktop).
> Login dengan passkey kamu (fingerprint/PIN/security key).
> Session tersimpan otomatis. Hanya perlu 1x (atau saat session expired).
>
> **Untuk VPS tanpa GUI**: Jalankan setup di PC lokal dulu,
> lalu copy folder `sessions/` ke VPS.

### 5. Test Vote

```bash
npm run vote
```

### 6. Start Bot (Auto tiap 1 jam)

```bash
npm run start
```

## 🖥️ VPS Deployment (PM2)

### Cara Transfer Session dari PC ke VPS

```bash
# Di PC lokal, setelah npm run setup berhasil:
scp -r ./sessions/ user@your-vps:/path/to/Edel/sessions/
```

### Start dengan PM2

```bash
# Start bot
pm2 start ecosystem.config.cjs

# Monitor logs realtime
pm2 logs edel-vote-bot

# Status
pm2 status

# Auto-start saat VPS reboot
pm2 startup
pm2 save
```

### PM2 Commands

```bash
pm2 restart edel-vote-bot    # Restart bot
pm2 stop edel-vote-bot       # Stop bot
pm2 delete edel-vote-bot     # Remove dari PM2
pm2 logs edel-vote-bot --lines 50  # Lihat 50 log terakhir
```

## 📨 Telegram Notifications

Bot akan otomatis kirim notifikasi ke Telegram kamu:

| Event | Pesan |
|---|---|
| ✅ Vote berhasil | Asset yang dipilih, strategy, waktu |
| ❌ Vote gagal | Error detail, retry info |
| ℹ️ Sudah voted | Status, jadwal berikutnya |
| 🔑 Session expired | Instruksi re-login |
| 🤖 Bot started | Config summary |
| ⏰ Next vote | Estimasi waktu vote berikutnya |
| 🛑 Bot stopped | Waktu shutdown |

## ⚙️ Configuration (.env)

| Variable | Default | Description |
|---|---|---|
| `VOTE_STRATEGY` | `smart` | `random` / `smart` / `first` / `second` |
| `CRON_SCHEDULE` | `0 */1 * * *` | Cron expression (default: tiap jam) |
| `HEADLESS` | `true` | `true` untuk VPS, `false` untuk debug |
| `SLOW_MO` | `500` | Delay antar aksi (ms), makin tinggi makin mirip manusia |
| `PAGE_TIMEOUT` | `30000` | Timeout tunggu halaman (ms) |
| `MAX_RETRIES` | `3` | Jumlah retry jika gagal |
| `SAVE_SCREENSHOTS` | `true` | Simpan screenshot tiap vote |
| `TELEGRAM_BOT_TOKEN` | _(kosong)_ | Token dari @BotFather |
| `TELEGRAM_CHAT_ID` | _(kosong)_ | Chat ID Telegram kamu |

## 🎯 Voting Strategies

| Strategy | Deskripsi |
|---|---|
| `random` | Pilih acak dari pilihan yang tersedia |
| `smart` | Analisa vote counts, pilih yang paling populer (momentum) |
| `first` | Selalu pilih opsi pertama (kiri) |
| `second` | Selalu pilih opsi kedua (kanan) |

## 📁 Folder Structure

```
Edel/
├── package.json           # Dependencies & scripts
├── .env                   # Config kamu (JANGAN COMMIT!)
├── .env.example           # Config template
├── ecosystem.config.cjs   # PM2 deployment config
├── src/
│   ├── index.js           # CLI entry point
│   ├── auth/
│   │   ├── login.js       # Passkey login + browser launch
│   │   └── session.js     # Session save/load/validate
│   ├── bot/
│   │   └── voter.js       # Core voting logic + smart strategy
│   ├── scheduler/
│   │   └── cron.js        # Cron scheduling + retry + Telegram
│   └── utils/
│       ├── config.js      # Config loader
│       ├── logger.js      # Winston logger
│       └── telegram.js    # Telegram Bot API notifications
├── sessions/              # Saved login sessions (JANGAN COMMIT!)
├── screenshots/           # Vote evidence screenshots
└── logs/                  # Log files
```

## ⚠️ Troubleshooting

### "Session expired"
→ Jalankan `npm run setup` ulang untuk login lagi.
→ Bot akan kirim notif Telegram otomatis kalau session expired.

### "No voting options found"
→ Mungkin belum ada active listing call, atau UI berubah.
→ Cek screenshot di folder `screenshots/` untuk debug.
→ Jalankan dengan `HEADLESS=false` untuk lihat browser.

### Browser crash di VPS
```bash
# Install Playwright system deps
npx playwright install-deps chromium

# Atau install secara manual
sudo apt-get install -y libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0
```

### Session transfer ke VPS
1. Login di PC lokal: `npm run setup` (butuh GUI)
2. Copy session: `scp -r ./sessions/ user@vps:/path/to/Edel/sessions/`
3. Di VPS: `pm2 start ecosystem.config.cjs`

### Telegram tidak kirim notif
1. Pastikan `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` sudah diisi di `.env`
2. Pastikan kamu sudah kirim pesan ke bot (bot tidak bisa kirim pesan duluan)
3. Test manual: buka `https://api.telegram.org/bot<TOKEN>/getUpdates`

## 📜 Disclaimer

> Bot ini dibuat untuk keperluan edukasi. Penggunaan automasi mungkin melanggar
> Terms & Conditions dari Edel Finance. Gunakan dengan risiko sendiri.
> Developer tidak bertanggung jawab atas konsekuensi penggunaan bot ini.
