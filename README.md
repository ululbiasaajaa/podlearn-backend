# 🎙️ PodLearn - AI Interactive Podcast & Quiz Generator

**PodLearn** adalah platform belajar berbasis AI yang mengubah dokumen edukasi (PDF/TXT) atau teks materi apa pun menjadi **podcast percakapan 2 pembicara** yang interaktif, lengkap dengan kuis evaluasi dan fitur tanya-jawab AI di tengah pemutaran.

Dibuat untuk mengatasi rasa bosan belajar dengan cara membaca materi kering — jadikan materi itu obrolan santai yang bisa didengarkan sambil rebahan atau di perjalanan.

---

## ✨ Fitur

- 📄 **Ekstraksi Dokumen** — Upload PDF/TXT (maks. 10MB) atau tempel teks materi langsung.
- 🧠 **Generate Naskah & Kuis via AI** — Google Gemini (`gemini-3.6-flash`) menyusun dialog Host ("Rian") x Expert ("Maya") plus 10 soal pilihan ganda berdasarkan materi.
- 🎚️ **Depth Control (3 Mode)** — Ringkas ⚡ / Standar / Mendalam 📖, masing-masing mengubah instruksi prompt & batas token, bukan cuma panjang teksnya.
- 🗣️ **Multi-Speaker Neural TTS** — Microsoft Edge Neural TTS (`node-edge-tts`), suara pria untuk Host dan wanita untuk Expert.
- 🎧 **Player Segmen Interaktif** — Putar per segmen (bukan file gabungan), kontrol prev/next, kecepatan putar 1x–2x, bubble naskah yang bisa diklik langsung ke segmen tersebut.
- 💬 **Tanya Tutor AI** — Pause podcast kapan saja dan tanya AI soal bagian yang lagi didengar; jawaban dihasilkan dari materi sumber + konteks beberapa segmen terakhir.
- 💾 **Unduh Full Podcast** — Gabungkan seluruh segmen jadi satu file MP3 via FFmpeg di server.
- 🔐 **Login Google & Riwayat Tersimpan** — Autentikasi via Supabase, riwayat podcast per-user (lanjutkan/mulai ulang/hapus), progres pemutaran otomatis tersimpan.
- ⭐ **Feedback Popup** — Muncul berkala (maks. 1x/24 jam), tanya rating + 1 pertanyaan follow-up acak, tanpa tracking perilaku detail.
- 🔒 **Rate Limiting Harian per User** — Batas jumlah podcast baru, pertanyaan ke Tutor AI, dan unduhan full podcast per hari (bisa dikonfigurasi lewat env var).
- 🛡️ **Concurrency Lock** — Mencegah user menjalankan 2 proses generate yang sama secara bersamaan (respons 409).

---

## 🛠️ Tech Stack

**Backend**
- Node.js + Express.js (ES Modules)
- Google GenAI SDK (`@google/genai`) — text generation, dengan multi-API-key rotation untuk menghindari rate limit
- `node-edge-tts` — Text-to-Speech
- `fluent-ffmpeg` + `ffmpeg-static` — penggabungan audio
- `pdf-parse` (v2, class-based API) — ekstraksi teks PDF
- `multer` — upload file
- `@supabase/supabase-js` — auth, database, dan storage

**Frontend**
- HTML5 + Vanilla JavaScript (ES6+) — single file, tanpa framework
- CSS custom (bukan Tailwind) dengan tema light/dark, animated gradient mesh (light mode) & starfield (dark mode)
- Supabase JS Client (CDN) untuk auth & query langsung dari browser

**Database & Storage**
- Supabase Postgres — tabel `podcasts`, `usage_logs`, `feedback`, `user_feedback_state`
- Supabase Storage — bucket `podcast-audio` untuk file MP3 per segmen
- Row Level Security (RLS) aktif, akses data selalu di-scope ke user yang login

---

## 📂 Struktur Proyek

Codebase-nya sengaja diusahakan minimal — cuma dua file utama:

```
podlearn/
├── index.html   # Seluruh frontend (UI, styling, logic client-side)
├── index.js     # Seluruh backend (API routes, integrasi Gemini/TTS/FFmpeg/Supabase)
└── package.json
```

---

## 🚀 Menjalankan Secara Lokal

### 1. Clone repository

```bash
git clone https://github.com/USERNAME/podlearn.git
cd podlearn
```

### 2. Install dependencies

```bash
npm install
```

### 3. Siapkan environment variables

Buat file `.env` di root project:

```env
# Wajib
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
GEMINI_API_KEYS=key1,key2,key3   # bisa 1 key atau lebih, dipisah koma

# Opsional
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key   # untuk kebutuhan admin internal
PORT=5000
TTS_BATCH_SIZE=3
DAILY_LIMIT_CREATE_PODCAST=5
DAILY_LIMIT_ASK_QUESTION=20
DAILY_LIMIT_DOWNLOAD_FULL=5
```

> ⚠️ `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `GEMINI_API_KEYS` (atau `GEMINI_API_KEY`) **wajib diisi** — server akan langsung `throw` saat start kalau kosong.

### 4. Siapkan Supabase

Pastikan project Supabase punya:
- Tabel `podcasts`, `usage_logs`, `feedback`, `user_feedback_state` dengan RLS aktif
- Bucket storage `podcast-audio`
- Google OAuth provider diaktifkan di Supabase Auth
- GRANT (SELECT/INSERT/UPDATE) ke role `authenticated` pada semua tabel di atas

### 5. Jalankan server

```bash
node index.js
```

Server jalan di `http://localhost:5000` (atau sesuai `PORT`), dan otomatis serve `index.html` sebagai static file.

---

## 🔑 Catatan Implementasi

- **Model AI** terpusat di satu konstanta `GEMINI_MODEL`, gampang diganti kalau ada model baru/deprecated.
- **TTS & full-podcast generation** dijalankan secara *batched* (bukan sequential satu-satu, bukan juga sekaligus semua) untuk balance antara kecepatan dan risiko throttle dari endpoint TTS.
- **File audio temporer** di server otomatis dibersihkan tiap 10 menit (file berumur >15 menit dihapus).
- Endpoint `/temp-audio` dan seluruh endpoint API dilindungi middleware auth (Bearer JWT dari Supabase).

---

## 📌 Roadmap Singkat

- [ ] Uji ke lebih banyak pengguna di luar lingkaran teman dekat
- [ ] Evaluasi opsi TTS yang lebih natural (EdgeTTS saat ini masih terdengar agak robotic)
- [ ] Pertimbangan model freemium untuk monetisasi