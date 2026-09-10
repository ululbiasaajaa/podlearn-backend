import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { EdgeTTS } from 'node-edge-tts';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';
import multer from 'multer';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ============================================================
// 🔧 SAFE PDF PARSER (Node.js ESM Fix)
//
// 🔧 REVISI: package "pdf-parse" yang ter-install ternyata versi 2.x,
// yang API-nya di-rewrite total oleh maintainer-nya dari function biasa
// (v1: `pdf(buffer).then(...)`) menjadi CLASS based (v2):
//
//   const { PDFParse } = require('pdf-parse');
//   const parser = new PDFParse({ data: buffer });
//   const result = await parser.getText();
//   console.log(result.text);
//   await parser.destroy();
//
// Referensi resmi: https://www.npmjs.com/package/pdf-parse
// Ini dikonfirmasi via diagnostic log sebelumnya: hasil require('pdf-parse')
// adalah object berisi named export class "PDFParse" (beserta beberapa
// class exception/table lain), bukan function langsung. Fix ini mengambil
// class PDFParse tersebut secara eksplisit, bukan mencoba treat module-nya
// sebagai function.
// ============================================================
let PDFParseClass = null;

try {
  const mod = require('pdf-parse');
  PDFParseClass = (mod && typeof mod.PDFParse === 'function')
    ? mod.PDFParse
    : (typeof mod === 'function' ? mod : null); // fallback jaga-jaga andai suatu saat rollback ke v1
} catch (err) {
  console.error('❌ Gagal memuat library pdf-parse:', err.message);
}

if (!PDFParseClass) {
  console.error('❌ Class PDFParse tidak ditemukan di package "pdf-parse". Cek versi package yang ter-install.');
}

// Single Source of Truth untuk Model Gemini
const GEMINI_MODEL = 'gemini-3.6-flash';

// Set path FFmpeg Static
ffmpeg.setFfmpegPath(ffmpegInstaller);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
// 🔧 FIX (Security): static('.') sebelumnya serve SELURUH folder project,
// termasuk index.js (source code backend) dan me-shadow route
// '/temp-audio' di bawah (karena express.static('.') match & handle
// request DULUAN sebelum sempat nyampe ke route yang ada requireAuth-nya
// -- akibatnya audio segmen siapa aja bisa diakses tanpa login, asal tau
// nama filenya). Sekarang cuma index.html yang diserve secara eksplisit.
app.get('/', (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'index.html'));
});

// ============================================================
// 🔒 SUPABASE CONFIG & CLIENTS (Strict Environment Variable)
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('❌ SUPABASE_URL dan SUPABASE_ANON_KEY wajib di-set di environment variables.');
}

// Service Role Client khusus untuk kebutuhan administratif internal
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    })
  : null;

if (supabaseAdmin) {
  console.log('✅ [Supabase Admin] Admin Client terinisialisasi (Server Internal Only).');
}

// User-Scoped Supabase Client (Menempelkan Bearer JWT user agar RLS berjalan)
function createUserClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

// ============================================================
// 🔒 AUTHENTICATION MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentication Token diperlukan.' });
    }

    const accessToken = authHeader.substring(7).trim();
    if (!accessToken) {
      return res.status(401).json({ success: false, error: 'Access token tidak ditemukan.' });
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });

    const { data: { user }, error } = await authClient.auth.getUser(accessToken);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Token tidak valid atau sudah expired.' });
    }

    req.user = user;
    req.accessToken = accessToken;
    req.supabase = createUserClient(accessToken);
    next();
  } catch (error) {
    console.error('❌ [Authentication Middleware Error] message:', error?.message);
    console.error('❌ [Authentication Middleware Error] stack:', error?.stack);
    return res.status(401).json({ success: false, error: 'Authentication gagal.' });
  }
}

// Ensure temp-audio and uploads directories exist
const tempAudioDir = path.join(process.cwd(), 'temp-audio');
const uploadsDir = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(tempAudioDir)) {
  fs.mkdirSync(tempAudioDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 🔒 PROTECTED Fallback Static Audio Server (Requires JWT Authorization)
app.use('/temp-audio', requireAuth, express.static(tempAudioDir));

// File Upload Config (Max 10MB & Filter PDF/TXT Only)
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['application/pdf', 'text/plain'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || ext === '.pdf' || ext === '.txt') {
      return cb(null, true);
    }
    cb(new Error('Hanya file PDF dan TXT yang diperbolehkan.'));
  }
});

// Background Cleanup Job: Deletes temp files older than 15 minutes
setInterval(() => {
  try {
    const files = fs.readdirSync(tempAudioDir);
    const now = Date.now();
    const maxAgeMs = 15 * 60 * 1000;

    files.forEach((file) => {
      const filePath = path.join(tempAudioDir, file);
      const stats = fs.statSync(filePath);
      const fileCreatedTime = stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs;
      const fileAge = now - fileCreatedTime;
      if (fileAge > maxAgeMs && fileAge > 60000) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (err) {
    console.error('❌ [Cleanup Error] message:', err?.message);
    console.error('❌ [Cleanup Error] stack:', err?.stack);
  }
}, 10 * 60 * 1000);

// ============================================
// 🔑 API KEY POOL & ROTATION (Server Side Only)
// ============================================
// ============================================================
// 🎧 TTS BATCHED CONCURRENCY (menggantikan sequential for-loop)
// ============================================================
// Batch size sengaja dibikin KONSERVATIF (default 3), bukan Promise.all
// polos ke semua segmen sekaligus -- karena EdgeTTS ini manggil endpoint
// Microsoft yang undocumented buat pemakaian kayak gini, dan kita ga tau
// batas aman rate/concurrent connection-nya di deployment ini. Batch
// kecil + berurutan antar-batch = balance antara "lebih cepat dari
// sequential" dan "ga nembak semua sekaligus dan berisiko kena
// throttle/connection error".
//
// Bisa dioverride lewat env var TTS_BATCH_SIZE tanpa perlu redeploy kode.
const TTS_BATCH_SIZE = parseInt(process.env.TTS_BATCH_SIZE || '3', 10);

/**
 * Jalankan `taskFn` untuk tiap item di `items` secara batched (bukan
 * sequential satu-satu, bukan juga Promise.all ke semuanya sekaligus).
 *
 * PENTING soal urutan: hasil akhir array `results` dijamin urut sesuai
 * index asli item di `items` -- BUKAN sesuai urutan selesai (completion
 * order). Ini karena di dalam satu batch, Promise.all() selalu
 * mengembalikan hasil di posisi yang sama dengan urutan promise yang
 * dimasukkan, walau promise mana yang selesai duluan itu random. Dan
 * antar-batch, batch berikutnya baru mulai setelah batch sebelumnya
 * settle semua. Jadi hasil.push per batch, digabung berurutan, otomatis
 * tetap by-index -- ga perlu sorting manual di akhir.
 *
 * `taskFn(item, index)` boleh return `null`/`undefined` untuk item yang
 * di-skip (mis. item tanpa `.text`), nanti otomatis di-filter.
 */
async function runInBatches(items, batchSize, taskFn) {
  const results = [];
  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
    const batchItems = items.slice(batchStart, batchStart + batchSize);
    const batchPromises = batchItems.map((item, offsetInBatch) =>
      taskFn(item, batchStart + offsetInBatch)
    );
    const batchResults = await Promise.all(batchPromises);
    batchResults.forEach((r) => {
      if (r !== null && r !== undefined) results.push(r);
    });
  }
  return results;
}

const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 0);

if (apiKeys.length === 0) {
  throw new Error('❌ GEMINI_API_KEYS (atau GEMINI_API_KEY) belum di-set di environment variables.');
}

let currentKeyIndex = 0;

function getAiClient() {
  return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

function rotateKey() {
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
}

async function callGeminiWithRetry(prompt, options = {}, retries) {
  // 🔧 MILESTONE 16: tambah opsi maxOutputTokens eksplisit.
  // Sebelumnya field ini TIDAK PERNAH di-set, murni default API.
  // Ini penting terutama untuk mode "Deep" yang bisa menghasilkan naskah
  // jauh lebih panjang -- tanpa batas eksplisit yang cukup besar, ada
  // risiko output ke-truncate di tengah sebelum JSON-nya closed dengan
  // benar, yang akan bikin JSON.parse(rawText) di endpoint gagal diam-diam
  // (gagal karena truncation, bukan karena kontennya emang segitu).
  const { useSchema = false, maxOutputTokens } = options;
  const maxRetries = retries || apiKeys.length * 2;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = getAiClient();

      const config = {};

      if (useSchema) {
        config.responseMimeType = 'application/json';
        config.responseSchema = {
          type: 'OBJECT',
          properties: {
            podcast_script: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  speaker: { type: 'STRING' },
                  text: { type: 'STRING' }
                },
                required: ['speaker', 'text']
              }
            },
            quiz: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  question: { type: 'STRING' },
                  options: {
                    type: 'ARRAY',
                    items: { type: 'STRING' }
                  },
                  answer: { type: 'STRING' }
                },
                required: ['question', 'options', 'answer']
              }
            }
          },
          required: ['podcast_script', 'quiz']
        };
      }

      if (maxOutputTokens) {
        config.maxOutputTokens = maxOutputTokens;
      }

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        ...(Object.keys(config).length > 0 && { config })
      });
      return response;
    } catch (error) {
      const isRateLimit = error?.status === 429 || error?.message?.includes('429');

      // 🔧 FIX: error 503 (model overload / status "UNAVAILABLE") sebelumnya
      // TIDAK PERNAH di-retry -- langsung throw di percobaan pertama walau
      // maxRetries masih banyak sisa. Padahal ini error transient (pesannya
      // sendiri bilang "Please try again later"). Sekarang di-retry dengan
      // exponential backoff (2s, 4s, 8s, 16s, ... dibatasi max 20s), tanpa
      // perlu rotate key karena ini bukan soal quota/rate limit per-key,
      // tapi server Gemini-nya sendiri yang lagi penuh.
      const isOverloaded =
        error?.status === 503 ||
        error?.message?.includes('503') ||
        error?.message?.includes('UNAVAILABLE') ||
        error?.message?.includes('overloaded') ||
        error?.message?.includes('high demand');

      if (isRateLimit) {
        rotateKey();
        if ((i + 1) % apiKeys.length === 0) {
          const waitTime = 15000 + (i * 2000);
          await new Promise(r => setTimeout(r, waitTime));
        }
      } else if (isOverloaded) {
        const isLastAttempt = i === maxRetries - 1;
        if (isLastAttempt) {
          throw error;
        }
        const backoffMs = Math.min(2000 * Math.pow(2, i), 20000);
        console.warn(`⚠️ [Gemini Overload] Percobaan ${i + 1}/${maxRetries} gagal (503), retry dalam ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        throw error;
      }
    }
  }

  throw new Error('Semua percobaan gagal setelah rotasi key + retry.');
}

// ============================================================
// 🎚️ MILESTONE 16 — PODCAST DEPTH CONTROL
// ============================================================

// Step 2: whitelist depth yang valid. Backend TIDAK PERNAH percaya
// value depth dari frontend mentah-mentah -- kalau kosong/typo/nilai
// aneh, fallback ke 'balanced'.
const VALID_DEPTHS = ['concise', 'balanced', 'deep'];

// Step 3: kontrak per depth. Ini BUKAN sekadar "buat lebih panjang/pendek",
// tapi instruksi struktural yang beda cara menjelaskan -- supaya yang
// diuji adalah depth (cara membahas), bukan cuma verbosity (panjang teks).
const DEPTH_INSTRUCTIONS = {
  concise: `
MODE PEMBAHASAN: RINGKAS
- Prioritaskan konsep inti dan poin utama saja.
- Buang detail sekunder, contoh tambahan, atau elaborasi yang tidak esensial.
- Percakapan tetap harus terasa natural, bukan sekadar dipotong paksa.
- Hindari mengulang poin yang sudah disampaikan.`,
  balanced: `
MODE PEMBAHASAN: STANDAR
- Jelaskan konsep utama secara lengkap dan jelas.
- Berikan konteks dan contoh yang relevan secukupnya untuk membantu pemahaman.
- Jaga pembahasan tetap fokus pada materi, jangan melebar ke topik yang tidak terkait.`,
  deep: `
MODE PEMBAHASAN: MENDALAM
- Cover materi secara lebih menyeluruh, termasuk sub-topik yang relevan.
- Jelaskan hubungan antar-konsep, bukan cuma membahas satu-satu secara terpisah.
- Sertakan konteks, mekanisme/cara kerja, contoh konkret, dan detail penting lain.
- JANGAN menambahkan fakta yang tidak didukung materi sumber (dilarang mengarang).
- JANGAN mengulang-ulang poin yang sama hanya untuk menambah panjang naskah --
  setiap kalimat baru wajib membawa informasi baru.`
};

// Batas token output per depth. Nilai untuk 'deep' sengaja dikasih ruang
// paling besar supaya naskah panjang + hubungan antar-konsep + 10 soal
// kuis tetap muat dalam satu response JSON tanpa ke-truncate.
const MAX_OUTPUT_TOKENS_BY_DEPTH = {
  concise: 4096,
  balanced: 6144,
  deep: 8192
};

// ============================================================
// 🔒 CONCURRENT GENERATION LOCK (per-user, per-job-type)
// ============================================================
// Masalah yang di-fix: kalau request generate-script masih diproses di
// backend (misal lagi retry 503 yang makan waktu puluhan detik) dan user
// keburu timeout/klik generate lagi, sebelumnya TIDAK ADA penjagaan --
// dua request jalan bersamaan, dua-duanya manggil Gemini, dan (kalau
// endpoint-nya charge usage limit) user bisa kepotong quota harian 2x
// untuk niat generate yang sama.
//
// Solusinya: in-memory lock per (userId + jobType). Selama user masih
// punya job jenis itu yang jalan, request baru buat job yang sama
// langsung ditolak (409) alih-alih diam-diam diproses dobel.
//
// CATATAN SKALA: ini in-memory (Map biasa), jadi cuma valid selama
// backend jalan di SATU instance/proses (sesuai deployment Railway
// sekarang). Kalau nanti di-scale ke multi-instance, lock ini perlu
// dipindah ke storage bersama (mis. Redis atau tabel di Supabase).
const activeGenerationJobs = new Set();

function acquireGenerationLock(userId, jobType) {
  const key = `${userId}:${jobType}`;
  if (activeGenerationJobs.has(key)) {
    return false;
  }
  activeGenerationJobs.add(key);
  return true;
}

function releaseGenerationLock(userId, jobType) {
  activeGenerationJobs.delete(`${userId}:${jobType}`);
}

function getContextForQuestion(podcastScript, currentIndex) {
  if (!Array.isArray(podcastScript) || podcastScript.length === 0) return [];

  const safeIndex = Math.min(Math.max(0, currentIndex), podcastScript.length - 1);
  const startIndex = Math.max(0, safeIndex - 3);

  return podcastScript.slice(startIndex, safeIndex + 1);
}

// ============================================================
// 📊 USAGE TRACKING & RATE LIMITING (Milestone 16)
// ============================================================

// Limit harian per-user, bisa dioverride lewat environment variable
// biar gampang diubah tanpa perlu redeploy kode (cukup restart env var di Railway)
const DAILY_LIMITS = {
  create_podcast: parseInt(process.env.DAILY_LIMIT_CREATE_PODCAST || '5', 10),
  ask_question: parseInt(process.env.DAILY_LIMIT_ASK_QUESTION || '20', 10),
  download_full_podcast: parseInt(process.env.DAILY_LIMIT_DOWNLOAD_FULL || '5', 10)
};

/**
 * Cek apakah user masih dalam batas harian untuk actionType tertentu.
 * Kalau masih di bawah limit, langsung catat log usage-nya (insert row)
 * dan return { allowed: true }.
 * Kalau sudah kena limit, TIDAK insert log baru, return { allowed: false }.
 *
 * Dicatat SEBELUM proses mahal (Gemini/TTS/FFmpeg) dijalankan, bukan
 * sesudahnya -- supaya kalaupun proses di tengah jalan gagal/timeout,
 * user tetap "kena charge" 1 usage. Ini trade-off sengaja: lebih aman
 * buat proteksi cost daripada precise buat UX (user bisa komplain
 * "gagal tapi kepotong limit" -- itu risiko yang lebih baik daripada
 * limit gampang dilewatin lewat request yang sengaja di-abort).
 */
async function checkAndLogUsage(userSupabase, userId, actionType) {
  const dailyLimit = DAILY_LIMITS[actionType];
  if (!dailyLimit) {
    // actionType tidak dikenali -> jangan block, tapi jangan diam-diam juga
    console.warn(`⚠️ [Usage] actionType tidak dikenal: ${actionType}`);
    return { allowed: true, currentCount: 0, limit: null };
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count, error: countError } = await userSupabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .gte('created_at', twentyFourHoursAgo);

  if (countError) {
    // Kalau gagal cek usage (misal tabel belum ke-migrate), fail-open
    // (tetap izinkan) supaya bug di sistem tracking tidak mem-blokir
    // fungsi utama aplikasi.
    //
    // 🔍 DIAGNOSTIC: sebelumnya cuma log countError.message, tapi ternyata
    // kosong -- kemungkinan besar bentuk error object dari Supabase/PostgREST
    // beda dari yang diasumsikan (bukan Error biasa). Log lebih lengkap
    // (code, details, hint, dan full JSON) biar akar masalahnya ketahuan
    // pasti, bukan nebak lagi.
    console.error('❌ [Usage Check Error] code:', countError.code);
    console.error('❌ [Usage Check Error] message:', countError.message);
    console.error('❌ [Usage Check Error] details:', countError.details);
    console.error('❌ [Usage Check Error] hint:', countError.hint);
    console.error('❌ [Usage Check Error] full JSON:', JSON.stringify(countError));
    return { allowed: true, currentCount: 0, limit: dailyLimit };
  }

  const currentCount = count || 0;
  if (currentCount >= dailyLimit) {
    return { allowed: false, currentCount, limit: dailyLimit };
  }

  const { error: insertError } = await userSupabase
    .from('usage_logs')
    .insert([{ user_id: userId, action_type: actionType }]);

  if (insertError) {
    console.error('❌ [Usage Log Insert Error] code:', insertError.code);
    console.error('❌ [Usage Log Insert Error] message:', insertError.message);
    console.error('❌ [Usage Log Insert Error] details:', insertError.details);
    console.error('❌ [Usage Log Insert Error] hint:', insertError.hint);
  }

  return { allowed: true, currentCount: currentCount + 1, limit: dailyLimit };
}

// ============================================================
// 💬 FEEDBACK SYSTEM DICTIONARY & HELPERS (Milestone 15)
// ============================================================
const FEEDBACK_QUESTIONS = {
  q1: 'Ada bagian yang kerasa ngebosenin/pengen di-skip?',
  q2: 'Kuisnya kerasa nyambung sama isi podcastnya nggak?',
  q3: 'Ada yang kerasa aneh/salah dari isi podcastnya?'
};

// Endpoint Health Check (Public)
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', timestamp: new Date() });
});

// Endpoint Extract PDF / TXT (Protected & Cleaned)
app.post('/api/extract-file', requireAuth, upload.single('file'), async (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Tidak ada file yang diunggah' });
    }

    filePath = req.file.path;
    const fileMime = req.file.mimetype;
    const originalName = req.file.originalname.toLowerCase();

    let extractedText = '';

    if (originalName.endsWith('.pdf') || fileMime === 'application/pdf') {
      if (!PDFParseClass) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(500).json({ success: false, error: 'Library PDF parser belum siap.' });
      }

      const dataBuffer = fs.readFileSync(filePath);

      // 🔧 REVISI: pakai API "pdf-parse" v2 yang class-based (bukan lagi
      // function biasa seperti v1). try-catch khusus parsing PDF tetap
      // dipertahankan biar error ASLI dari pdf-parse (nama, message, stack)
      // kelihatan di log Railway, bukan cuma ketutup sama pesan generik
      // di catch paling luar.
      let parser = null;
      try {
        parser = new PDFParseClass({ data: dataBuffer });
        const result = await parser.getText();
        extractedText = result.text || '';
      } catch (parseErr) {
        console.error('❌ [PDF Parse Error] name:', parseErr?.name);
        console.error('❌ [PDF Parse Error] message:', parseErr?.message);
        console.error('❌ [PDF Parse Error] stack:', parseErr?.stack);
        throw parseErr; // tetap dilempar ke catch luar agar response ke client tidak berubah
      } finally {
        if (parser && typeof parser.destroy === 'function') {
          try { await parser.destroy(); } catch (destroyErr) {}
        }
      }
    } else if (originalName.endsWith('.txt') || fileMime === 'text/plain') {
      extractedText = fs.readFileSync(filePath, 'utf8');
    } else {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: 'Format file tidak didukung.' });
    }

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Membersihkan karakter non-printable / binary liar
    const cleanExtractedText = extractedText
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
      .trim()
      .substring(0, 8000);

    if (!cleanExtractedText) {
      return res.status(400).json({
        success: false,
        error: 'File PDF berupa scan gambar atau tidak mengandung teks terbaca.'
      });
    }

    return res.json({ success: true, text: cleanExtractedText });

  } catch (error) {
    console.error('❌ [Extract File Error]:', error.message || error);

    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }

    return res.status(500).json({
      success: false,
      error: 'Gagal membaca dokumen. Pastikan PDF berisikan teks biasa dan tidak dilindungi sandi.'
    });
  }
});

// Endpoint 1: Generate Naskah & Quiz (Protected)
app.post('/api/generate-script', requireAuth, async (req, res) => {
  const userId = req.user.id;

  // 🔒 Cegah user yang sama menjalankan 2 generation job bersamaan.
  if (!acquireGenerationLock(userId, 'generate-script')) {
    return res.status(409).json({
      success: false,
      error: 'Podcast sebelumnya masih diproses. Mohon tunggu sebentar sebelum generate lagi.'
    });
  }

  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Teks materi tidak boleh kosong' });
    }

    // 🎚️ Step 2: defensive validation. Frontend cuma boleh kirim enum,
    // BUKAN instruksi prompt mentah. Kalau value-nya invalid/kosong/typo,
    // fallback diam-diam ke 'balanced' -- backend yang menentukan aturan.
    const depth = VALID_DEPTHS.includes(req.body.depth) ? req.body.depth : 'balanced';

    // 📊 Rate limit check: batasi jumlah podcast baru per-hari per-user
    const usageCheck = await checkAndLogUsage(req.supabase, req.user.id, 'create_podcast');
    if (!usageCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: `Batas harian tercapai (${usageCheck.currentCount}/${usageCheck.limit} podcast hari ini). Coba lagi besok ya!`
      });
    }

    const cleanText = text.trim().substring(0, 12000);

    // Step 4: jumlah kuis TETAP 10 di semua mode depth -- ini sengaja
    // dikunci biar eksperimen depth clean (variabel yang berubah cuma
    // naskahnya, bukan ikut jumlah kuisnya).
    const prompt = `
Ubah materi berikut menjadi naskah podcast percakapan 2 orang:
1. "Rian" (Host Cowok yang santai, penasaran, dan bertanya).
2. "Maya" (Expert Cewek yang menjelaskan pakai analogi sederhana dan ramah).
${DEPTH_INSTRUCTIONS[depth]}

Sertakan juga TEPAT 10 soal kuis pilihan ganda yang komprehensif berdasarkan materi tersebut.

ATURAN FORMAT KUIS (WAJIB DIIKUTI PERSIS, JANGAN DILANGGAR):
- Setiap soal harus punya TEPAT 4 opsi jawaban.
- Setiap opsi WAJIB diawali huruf dan titik, contoh: "A. teks jawaban", "B. teks jawaban", "C. teks jawaban", "D. teks jawaban".
- Field "answer" HANYA berisi SATU HURUF KAPITAL (A, B, C, atau D) yang sesuai opsi yang benar -- JANGAN sertakan teks jawaban di field ini, cukup hurufnya saja. Contoh benar: "B". Contoh salah: "B. Pengujian toksisitas...".

Materi:
${cleanText}
`;

    // 📊 BENCHMARK: ukur durasi panggilan Gemini itu sendiri (terpisah dari
    // durasi total request). Ini buat diagnosa apakah timeout di frontend
    // (60s) disebabkan oleh generation yang emang lama, atau oleh retry
    // 503 yang numpuk backoff-nya -- kalau ada retry, log "[Gemini Overload]"
    // dari callGeminiWithRetry bakal muncul duluan sebelum baris ini.
    const geminiStart = Date.now();
    const response = await callGeminiWithRetry(prompt, {
      useSchema: true,
      maxOutputTokens: MAX_OUTPUT_TOKENS_BY_DEPTH[depth]
    });
    const geminiDuration = Date.now() - geminiStart;
    console.log(`📊 [Generate Script Benchmark] depth=${depth} geminiDurationMs=${geminiDuration}`);

    const rawText = response.text || '';
    const parsedData = JSON.parse(rawText);

    // 📊 Step 5: logging metrik depth -- fondasi buat eksperimen &
    // kalibrasi durasi nanti, tanpa perlu bikin dashboard analytics dulu.
    const segmentCount = Array.isArray(parsedData.podcast_script) ? parsedData.podcast_script.length : 0;
    const wordCount = Array.isArray(parsedData.podcast_script)
      ? parsedData.podcast_script.reduce((sum, seg) => {
          const words = (seg?.text || '').trim().split(/\s+/).filter(Boolean).length;
          return sum + words;
        }, 0)
      : 0;

    console.log(`📊 [Generate Script Metrics] depth=${depth} wordCount=${wordCount} segmentCount=${segmentCount}`);

    res.json({
      success: true,
      // depth ikut dibalikin ke frontend, supaya sumber kebenarannya tetap
      // backend (bukan frontend nebak ulang value apa yang tadi dikirim)
      // saat frontend nyimpen record podcast ke DB.
      data: { ...parsedData, depth },
    });
  } catch (error) {
    console.error('❌ [Generate Script Error] message:', error?.message);
    console.error('❌ [Generate Script Error] stack:', error?.stack);
    res.status(500).json({ success: false, error: 'Gagal membuat naskah podcast' });
  } finally {
    releaseGenerationLock(userId, 'generate-script');
  }
});

// Endpoint 2: Generate Audio Per Segment (Protected & Scoped Storage)
app.post('/api/generate-audio-segments', requireAuth, async (req, res) => {
  const createdTempFiles = [];
  const userId = req.user.id;

  // 🔒 Cegah user yang sama menjalankan 2 generation job bersamaan.
  if (!acquireGenerationLock(userId, 'generate-audio-segments')) {
    return res.status(409).json({
      success: false,
      error: 'Proses pembuatan audio sebelumnya masih berjalan. Mohon tunggu sebentar.'
    });
  }

  try {
    const { podcast_script, podcast_id, depth } = req.body;

    if (!podcast_id || typeof podcast_id !== 'string') {
      return res.status(400).json({ success: false, error: 'podcast_id wajib diisi!' });
    }

    if (!podcast_script || !Array.isArray(podcast_script) || podcast_script.length === 0) {
      return res.status(400).json({ success: false, error: 'Array podcast_script wajib diisi!' });
    }

    // 📊 BENCHMARK: sekarang mode=batched (sebelumnya sequential). Bandingkan
    // ttsDurationMs ini dengan baseline sequential yang udah kita punya
    // (Ringkas 30.2s / Standar 69.3s / Mendalam 80.9s).
    const ttsStart = Date.now();
    const segmentCount = podcast_script.length;

    const userSupabase = req.supabase;

    // Task per-segmen: generate TTS + upload ke storage (kalau login).
    // Return null buat item yang di-skip (tanpa .text) -- runInBatches
    // otomatis nge-filter null ini.
    const synthesizeOneSegment = async (item, index) => {
      if (!item || !item.text) return null;

      let selectedVoice = 'id-ID-ArdiNeural';
      if (item.speaker === 'Maya') {
        selectedVoice = 'id-ID-GadisNeural';
      }

      const tts = new EdgeTTS({
        voice: selectedVoice,
        lang: 'id-ID',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 30000
      });

      const uniqueFilename = `segment_${index}_${crypto.randomUUID()}.mp3`;
      const absolutePath = path.resolve(tempAudioDir, uniqueFilename);
      let finalAudioUrl = `/temp-audio/${uniqueFilename}`;

      try {
        await tts.ttsPromise(item.text, absolutePath);
        createdTempFiles.push(absolutePath);
      } catch (ttsError) {
        console.error(`❌ [TTS Segments Batched] Segmen ${index} gagal`);
        throw ttsError;
      }

      if (userId && userSupabase) {
        try {
          const storagePath = `${userId}/${podcast_id}/segment_${index}.mp3`;
          const fileBuffer = fs.readFileSync(absolutePath);

          const { error: uploadError } = await userSupabase.storage
            .from('podcast-audio')
            .upload(storagePath, fileBuffer, {
              contentType: 'audio/mpeg',
              upsert: true
            });

          if (!uploadError) {
            const { data: publicUrlData } = userSupabase.storage
              .from('podcast-audio')
              .getPublicUrl(storagePath);

            finalAudioUrl = publicUrlData.publicUrl;

            if (fs.existsSync(absolutePath)) {
              fs.unlinkSync(absolutePath);
              const idx = createdTempFiles.indexOf(absolutePath);
              if (idx > -1) createdTempFiles.splice(idx, 1);
            }
          }
        } catch (stErr) {
          // Fallback lokal aktif jika upload ke storage mengalami kendala
        }
      }

      return {
        index,
        speaker: item.speaker || 'Host',
        audioUrl: finalAudioUrl
      };
    };

    // Kalau salah satu segmen di dalam batch gagal, Promise.all() di dalam
    // runInBatches otomatis reject -- melempar error ke luar persis kayak
    // `throw ttsError` di versi sequential dulu, jadi behavior kegagalannya
    // konsisten (satu segmen gagal = seluruh request gagal).
    const segments = await runInBatches(podcast_script, TTS_BATCH_SIZE, synthesizeOneSegment);

    // 📊 BENCHMARK: catat durasi total TTS. `depth` di sini cuma label buat
    // korelasi log (dikirim opsional dari frontend) -- TIDAK mempengaruhi
    // logic sama sekali, cuma metadata.
    const ttsEnd = Date.now();
    const ttsDuration = ttsEnd - ttsStart;
    console.log(`📊 [TTS Benchmark] mode=batched batchSize=${TTS_BATCH_SIZE} depth=${depth || 'unknown'} segmentCount=${segmentCount} ttsDurationMs=${ttsDuration}`);

    res.json({
      success: true,
      segments
    });

  } catch (error) {
    console.error('❌ [Generate Audio Segments Error] message:', error?.message);
    console.error('❌ [Generate Audio Segments Error] stack:', error?.stack);

    createdTempFiles.forEach(f => {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    });

    res.status(500).json({ success: false, error: 'Gagal membuat segmen audio' });
  } finally {
    releaseGenerationLock(userId, 'generate-audio-segments');
  }
});

// Endpoint 3: Generate & Merge Audio (Protected)
app.post('/api/generate-full-podcast', requireAuth, async (req, res) => {
  const tempFiles = [];
  const reqId = crypto.randomUUID();
  const listFilePath = path.resolve(process.cwd(), `concat_list_${reqId}.txt`);
  const outputPath = path.resolve(process.cwd(), `full_podcast_${reqId}.mp3`);
  const userId = req.user.id;
  const LOCK_JOB_TYPE = 'generate-full-podcast';

  const cleanAllTemp = () => {
    tempFiles.forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {} });
    if (fs.existsSync(listFilePath)) try { fs.unlinkSync(listFilePath); } catch (e) {}
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (e) {}
  };

  // 🔒 Cegah user yang sama menjalankan 2 generation job bersamaan.
  if (!acquireGenerationLock(userId, LOCK_JOB_TYPE)) {
    return res.status(409).json({
      success: false,
      error: 'Proses pembuatan full podcast sebelumnya masih berjalan. Mohon tunggu sebentar.'
    });
  }

  // ⚠️ Endpoint ini pakai FFmpeg yang event-based (callback .on('end')/
  // .on('error')), jadi try/finally biasa TIDAK cukup -- kalau lock
  // dilepas di finally, dia bakal kelepas sebelum proses FFmpeg-nya
  // benar-benar selesai (karena .run() non-blocking). Makanya release
  // lock dipasang manual di TIAP jalur keluar (validasi gagal, rate
  // limit, error TTS, dan kedua callback FFmpeg).

  try {
    const { podcast_script } = req.body;

    if (!podcast_script || !Array.isArray(podcast_script) || podcast_script.length === 0) {
      releaseGenerationLock(userId, LOCK_JOB_TYPE);
      return res.status(400).json({ success: false, error: 'Array podcast_script wajib diisi!' });
    }

    // 📊 Rate limit check: batasi jumlah download full podcast per-hari per-user
    // (endpoint ini paling mahal -- TTS ulang semua segmen + FFmpeg merge)
    const usageCheck = await checkAndLogUsage(req.supabase, req.user.id, 'download_full_podcast');
    if (!usageCheck.allowed) {
      releaseGenerationLock(userId, LOCK_JOB_TYPE);
      return res.status(429).json({
        success: false,
        error: `Batas harian download full podcast tercapai (${usageCheck.currentCount}/${usageCheck.limit} hari ini). Coba lagi besok ya!`
      });
    }

    // 📊 BENCHMARK: sama kayak generate-audio-segments, sekarang batched.
    // Urutan tempFiles WAJIB tetap sesuai urutan playback podcast (index),
    // karena FFmpeg concat menggabungkan file persis sesuai urutan di
    // listFilePath -- runInBatches menjamin ini (lihat komentar di
    // definisinya), jadi aman dipakai di sini juga.
    const ttsStart = Date.now();
    const segmentCount = podcast_script.length;

    const synthesizeOneFullSegment = async (item, index) => {
      if (!item || !item.text) return null;

      const selectedVoice = (item.speaker === 'Rian') ? 'id-ID-ArdiNeural' : 'id-ID-GadisNeural';

      const tts = new EdgeTTS({
        voice: selectedVoice,
        lang: 'id-ID',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 30000
      });

      const tempPath = path.resolve(process.cwd(), `temp_${index}_${crypto.randomUUID()}.mp3`);

      try {
        await tts.ttsPromise(item.text, tempPath);
        return tempPath;
      } catch (ttsError) {
        console.error(`❌ [TTS Full Batched] Segmen ${index} gagal`);
        throw ttsError;
      }
    };

    const batchedTempFiles = await runInBatches(podcast_script, TTS_BATCH_SIZE, synthesizeOneFullSegment);
    tempFiles.push(...batchedTempFiles);

    const ttsDuration = Date.now() - ttsStart;
    console.log(`📊 [TTS Benchmark - Full Podcast] mode=batched batchSize=${TTS_BATCH_SIZE} segmentCount=${segmentCount} ttsDurationMs=${ttsDuration}`);

    const fileListContent = tempFiles
      .map(f => `file '${f.replace(/\\/g, '/')}'`)
      .join('\n');

    fs.writeFileSync(listFilePath, fileListContent);

    ffmpeg()
      .input(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions('-c copy')
      .output(outputPath)
      .on('end', () => {
        releaseGenerationLock(userId, LOCK_JOB_TYPE);
        res.sendFile(outputPath, () => {
          cleanAllTemp();
        });
      })
      .on('error', (err) => {
        console.error('❌ [FFmpeg Error]');
        releaseGenerationLock(userId, LOCK_JOB_TYPE);
        cleanAllTemp();
        res.status(500).json({ success: false, error: 'Gagal menggabungkan audio podcast' });
      })
      .run();

  } catch (error) {
    console.error('❌ [Full Podcast Error]');
    releaseGenerationLock(userId, LOCK_JOB_TYPE);
    cleanAllTemp();
    res.status(500).json({ success: false, error: 'Gagal memproses full podcast' });
  }
});

// Endpoint 4: Ask Question (Protected)
app.post('/api/ask-question', requireAuth, async (req, res) => {
  try {
    const { question, currentIndex, podcastScript, sourceMaterial } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ success: false, error: 'Pertanyaan tidak boleh kosong.' });
    }

    if (typeof currentIndex !== 'number' || !podcastScript) {
      return res.status(400).json({ success: false, error: 'Parameter currentIndex dan podcastScript wajib diisi' });
    }

    // 📊 Rate limit check: batasi jumlah pertanyaan ke Tutor AI per-hari per-user
    const usageCheck = await checkAndLogUsage(req.supabase, req.user.id, 'ask_question');
    if (!usageCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: `Batas harian tanya Tutor AI tercapai (${usageCheck.currentCount}/${usageCheck.limit} hari ini). Coba lagi besok ya!`
      });
    }

    const contextSegments = getContextForQuestion(podcastScript, currentIndex);

    const prompt = `
Bertindaklah sebagai seorang Tutor AI yang ramah, membantu, dan jelas.
Learner sedang mendengarkan podcast edukasi dan menghentikan putaran audio untuk mengajukan pertanyaan.

Materi Sumber Utama (Source Material):
"""
${(sourceMaterial || '').substring(0, 8000) || 'Tidak ada teks materi tambahan.'}
"""

Konteks Percakapan Podcast Terakhir Didegar (maksimal 4 segmen):
${JSON.stringify(contextSegments, null, 2)}

Pertanyaan Learner:
"${question.trim()}"

Aturan Jawaban:
1. Jawab berdasarkan Materi Sumber dan Konteks Percakapan di atas.
2. JANGAN mengarang informasi yang tidak tertera pada materi.
3. Jelaskan dengan singkat, jelas, dan menggunakan bahasa Indonesia yang mudah dipahami.
4. Berikan jawaban langsung dalam teks biasa tanpa format JSON.
`;

    const response = await callGeminiWithRetry(prompt);
    const answerText = response.text ? response.text.trim() : 'Maaf, saya tidak dapat menjawab pertanyaan tersebut saat ini.';

    res.json({
      success: true,
      answer: answerText
    });

  } catch (error) {
    console.error('❌ [Ask Question Error]');
    res.status(500).json({ success: false, error: 'Gagal memproses pertanyaan' });
  }
});

// Endpoint 5: Hapus Podcast (Protected & Verified Ownership via User RLS)
app.post('/api/delete-podcast', requireAuth, async (req, res) => {
  try {
    const { podcast_id } = req.body;
    const userId = req.user.id;
    const userSupabase = req.supabase;

    if (!podcast_id || typeof podcast_id !== 'string') {
      return res.status(400).json({ success: false, error: 'podcast_id wajib diisi' });
    }

    // 1. Verifikasi Ownership DB via User Client RLS
    const { data: podcast, error: fetchErr } = await userSupabase
      .from('podcasts')
      .select('id, user_id')
      .eq('id', podcast_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchErr) {
      return res.status(500).json({ success: false, error: 'Gagal memverifikasi kepemilikan podcast.' });
    }

    if (!podcast) {
      return res.status(404).json({ success: false, error: 'Podcast tidak ditemukan atau bukan milik Anda.' });
    }

    // 2. Cleanup Storage Folder ({userId}/{podcast_id})
    const folderPath = `${userId}/${podcast_id}`;
    try {
      const { data: filesList, error: listError } = await userSupabase.storage
        .from('podcast-audio')
        .list(folderPath, { limit: 100 });

      if (!listError && filesList && filesList.length > 0) {
        const filesToRemove = filesList.filter(f => f.name).map(f => `${folderPath}/${f.name}`);
        if (filesToRemove.length > 0) {
          await userSupabase.storage
            .from('podcast-audio')
            .remove(filesToRemove);
        }
      }
    } catch (storageErr) {
      // Ignore non-fatal storage cleanup errors
    }

    // 3. Database Row Deletion (RLS User Client)
    const { error: dbError } = await userSupabase
      .from('podcasts')
      .delete()
      .eq('id', podcast_id)
      .eq('user_id', userId);

    if (dbError) {
      return res.status(500).json({ success: false, error: 'Gagal menghapus data podcast dari database' });
    }

    return res.json({ success: true, message: 'Podcast berhasil dihapus.' });

  } catch (err) {
    console.error('❌ Fatal Error pada /api/delete-podcast');
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan internal server.' });
  }
});

// ============================================================
// 💬 FEEDBACK ENDPOINTS (Milestone 15)
// ============================================================

// Endpoint A: Feedback Prompt Check (Protected)
app.get('/api/feedback/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const userSupabase = req.supabase;

    const { data, error } = await userSupabase
      .from('user_feedback_state')
      .select('last_prompted_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: 'Gagal mengecek status feedback prompt.' });
    }

    const now = Date.now();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    let showFeedback = false;

    if (!data || !data.last_prompted_at) {
      showFeedback = true;
    } else {
      const lastPromptedTime = new Date(data.last_prompted_at).getTime();
      if (now - lastPromptedTime >= twentyFourHoursMs) {
        showFeedback = true;
      }
    }

    if (!showFeedback) {
      return res.json({ success: true, showFeedback: false });
    }

    // Pilih 1 dari 3 pertanyaan acak
    const questionKeys = Object.keys(FEEDBACK_QUESTIONS);
    const randomKey = questionKeys[Math.floor(Math.random() * questionKeys.length)];

    return res.json({
      success: true,
      showFeedback: true,
      questionId: randomKey,
      questionText: FEEDBACK_QUESTIONS[randomKey]
    });

  } catch (err) {
    console.error('❌ Error pada GET /api/feedback/status');
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan internal server.' });
  }
});

// Endpoint B: Dismiss Feedback Prompt (Protected - UPSERT)
app.post('/api/feedback/dismiss', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const userSupabase = req.supabase;
    const nowIso = new Date().toISOString();

    const { error } = await userSupabase
      .from('user_feedback_state')
      .upsert({
        user_id: userId,
        last_prompted_at: nowIso,
        updated_at: nowIso
      }, { onConflict: 'user_id' });

    if (error) {
      return res.status(500).json({ success: false, error: 'Gagal memperbarui status feedback prompt.' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Error pada POST /api/feedback/dismiss');
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan internal server.' });
  }
});

// Endpoint C: Submit Feedback (Protected - UPSERT State + INSERT Feedback)
app.post('/api/feedback/submit', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const userSupabase = req.supabase;
    const { rating, questionId, followupAnswer, comment } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: 'Rating wajib diisi angka 1 sampai 5.' });
    }

    const questionText = FEEDBACK_QUESTIONS[questionId] || FEEDBACK_QUESTIONS.q1;
    const nowIso = new Date().toISOString();

    // 1. Simpan data feedback
    const { error: insertErr } = await userSupabase
      .from('feedback')
      .insert([
        {
          user_id: userId,
          rating: Math.round(rating),
          followup_question: questionText,
          followup_answer: typeof followupAnswer === 'string' ? followupAnswer.trim() : '',
          comment: typeof comment === 'string' ? comment.trim() : '',
          created_at: nowIso
        }
      ]);

    if (insertErr) {
      return res.status(500).json({ success: false, error: 'Gagal menyimpan data feedback.' });
    }

    // 2. Update/Upsert state last_prompted_at
    const { error: stateErr } = await userSupabase
      .from('user_feedback_state')
      .upsert({
        user_id: userId,
        last_prompted_at: nowIso,
        updated_at: nowIso
      }, { onConflict: 'user_id' });

    if (stateErr) {
      console.warn('⚠️ Feedback tersimpan namun gagal update state last_prompted_at:', stateErr.message);
    }

    return res.json({ success: true, message: 'Terima kasih atas feedback Anda!' });

  } catch (err) {
    console.error('❌ Error pada POST /api/feedback/submit');
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan internal server.' });
  }
});

// Global Multer Error Handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'Ukuran file maksimal 10 MB.' });
    }
    return res.status(400).json({ success: false, error: 'Upload file tidak valid.' });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server PodLearn berjalan di port ${PORT}`);
});