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
// Menggunakan createRequire untuk memanggil lib/pdf-parse.js secara langsung
//
// 🔧 REVISI: sebelumnya hasil require() langsung dipakai sebagai function,
// padahal tergantung versi package "pdf-parse" yang terpasang, module bisa
// saja ter-export sebagai object (mis. { default: fn }) alih-alih function
// langsung -- ini yang menyebabkan error runtime "pdfParse is not a function"
// walau proses require()-nya sendiri tidak melempar error/exception.
// Fix ini meng-unwrap ".default" bila hasil require bukan function,
// lalu memvalidasi hasil akhirnya benar-benar callable.
// ============================================================
function resolvePdfParseExport(mod) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  return null;
}

let pdfParse = null;
let pdfParseRawModule = null;

try {
  pdfParseRawModule = require('pdf-parse/lib/pdf-parse.js');
  pdfParse = resolvePdfParseExport(pdfParseRawModule);
} catch (e) {
  // lanjut ke fallback di bawah
}

if (!pdfParse) {
  try {
    pdfParseRawModule = require('pdf-parse');
    pdfParse = resolvePdfParseExport(pdfParseRawModule);
  } catch (err) {
    console.error('❌ Gagal memuat library pdf-parse:', err.message);
  }
}

if (!pdfParse) {
  // 🔍 DIAGNOSTIC: cetak bentuk asli module pdf-parse yang ter-require,
  // biar ketahuan persis struktur export-nya seperti apa (nama package
  // "pdf-parse" punya versi lama berbasis function biasa dan versi baru
  // (v2.x) berbasis class dengan API yang sama sekali berbeda).
  console.error('❌ Module pdf-parse berhasil di-require tapi bukan function yang valid (kemungkinan struktur export package berbeda dari yang diharapkan). Cek versi "pdf-parse" di package.json.');
  try {
    console.error('🔍 [PDF Parse Diagnostic] typeof module:', typeof pdfParseRawModule);
    console.error('🔍 [PDF Parse Diagnostic] Object.keys(module):', pdfParseRawModule ? Object.keys(pdfParseRawModule) : 'null/undefined');
    if (pdfParseRawModule && typeof pdfParseRawModule === 'object') {
      for (const key of Object.keys(pdfParseRawModule)) {
        console.error(`🔍 [PDF Parse Diagnostic] typeof module.${key}:`, typeof pdfParseRawModule[key]);
      }
    }
  } catch (diagErr) {
    console.error('🔍 [PDF Parse Diagnostic] Gagal introspeksi module:', diagErr.message);
  }
}

// Single Source of Truth untuk Model Gemini
const GEMINI_MODEL = 'gemini-3.6-flash';

// Set path FFmpeg Static
ffmpeg.setFfmpegPath(ffmpegInstaller);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('.'));

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
    console.error('❌ Authentication Middleware Error');
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
    console.error('❌ [Cleanup Error]: Gagal membersihkan temp files');
  }
}, 10 * 60 * 1000);

// ============================================
// 🔑 API KEY POOL & ROTATION (Server Side Only)
// ============================================
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
  const { useSchema = false } = options;
  const maxRetries = retries || apiKeys.length * 2;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = getAiClient();

      const config = useSchema ? {
        responseMimeType: 'application/json',
        responseSchema: {
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
        }
      } : undefined;

      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        ...(config && { config })
      });
      return response;
    } catch (error) {
      const isRateLimit = error?.status === 429 || error?.message?.includes('429');

      if (isRateLimit) {
        rotateKey();
        if ((i + 1) % apiKeys.length === 0) {
          const waitTime = 15000 + (i * 2000);
          await new Promise(r => setTimeout(r, waitTime));
        }
      } else {
        throw error;
      }
    }
  }

  throw new Error('Semua percobaan gagal setelah rotasi key + retry.');
}

function getContextForQuestion(podcastScript, currentIndex) {
  if (!Array.isArray(podcastScript) || podcastScript.length === 0) return [];

  const safeIndex = Math.min(Math.max(0, currentIndex), podcastScript.length - 1);
  const startIndex = Math.max(0, safeIndex - 3);

  return podcastScript.slice(startIndex, safeIndex + 1);
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
      if (!pdfParse) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(500).json({ success: false, error: 'Library PDF parser belum siap.' });
      }

      const dataBuffer = fs.readFileSync(filePath);

      // 🔧 REVISI: try-catch khusus parsing PDF, biar error ASLI dari pdf-parse
      // (nama, message, stack) kelihatan di log Railway, bukan cuma ketutup
      // sama pesan generik di catch paling luar.
      try {
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData.text || '';
      } catch (parseErr) {
        console.error('❌ [PDF Parse Error] name:', parseErr?.name);
        console.error('❌ [PDF Parse Error] message:', parseErr?.message);
        console.error('❌ [PDF Parse Error] stack:', parseErr?.stack);
        throw parseErr; // tetap dilempar ke catch luar agar response ke client tidak berubah
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
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Teks materi tidak boleh kosong' });
    }

    const cleanText = text.trim().substring(0, 12000);

    const prompt = `
Ubah materi berikut menjadi naskah podcast percakapan 2 orang:
1. "Rian" (Host Cowok yang santai, penasaran, dan bertanya).
2. "Maya" (Expert Cewek yang menjelaskan pakai analogi sederhana dan ramah).

Sertakan juga TEPAT 10 soal kuis pilihan ganda yang komprehensif berdasarkan materi tersebut.

ATURAN FORMAT KUIS (WAJIB DIIKUTI PERSIS, JANGAN DILANGGAR):
- Setiap soal harus punya TEPAT 4 opsi jawaban.
- Setiap opsi WAJIB diawali huruf dan titik, contoh: "A. teks jawaban", "B. teks jawaban", "C. teks jawaban", "D. teks jawaban".
- Field "answer" HANYA berisi SATU HURUF KAPITAL (A, B, C, atau D) yang sesuai opsi yang benar -- JANGAN sertakan teks jawaban di field ini, cukup hurufnya saja. Contoh benar: "B". Contoh salah: "B. Pengujian toksisitas...".

Materi:
${cleanText}
`;

    const response = await callGeminiWithRetry(prompt, { useSchema: true });
    const rawText = response.text || '';
    const parsedData = JSON.parse(rawText);

    res.json({
      success: true,
      data: parsedData,
    });
  } catch (error) {
    console.error('❌ Error Generating Script');
    res.status(500).json({ success: false, error: 'Gagal membuat naskah podcast' });
  }
});

// Endpoint 2: Generate Audio Per Segment (Protected & Scoped Storage)
app.post('/api/generate-audio-segments', requireAuth, async (req, res) => {
  const createdTempFiles = [];

  try {
    const { podcast_script, podcast_id } = req.body;
    const userId = req.user.id;

    if (!podcast_id || typeof podcast_id !== 'string') {
      return res.status(400).json({ success: false, error: 'podcast_id wajib diisi!' });
    }

    if (!podcast_script || !Array.isArray(podcast_script) || podcast_script.length === 0) {
      return res.status(400).json({ success: false, error: 'Array podcast_script wajib diisi!' });
    }

    const segments = [];
    const userSupabase = req.supabase;

    for (let i = 0; i < podcast_script.length; i++) {
      const item = podcast_script[i];
      if (!item || !item.text) continue;

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

      const uniqueFilename = `segment_${i}_${crypto.randomUUID()}.mp3`;
      const absolutePath = path.resolve(tempAudioDir, uniqueFilename);
      let finalAudioUrl = `/temp-audio/${uniqueFilename}`;

      await new Promise(r => setTimeout(r, 150));

      try {
        await tts.ttsPromise(item.text, absolutePath);
        createdTempFiles.push(absolutePath);
      } catch (ttsError) {
        console.error(`❌ [TTS Segments] Segmen ${i} gagal`);
        throw ttsError;
      }

      if (userId && userSupabase) {
        try {
          const storagePath = `${userId}/${podcast_id}/segment_${i}.mp3`;
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

      segments.push({
        index: i,
        speaker: item.speaker || 'Host',
        audioUrl: finalAudioUrl
      });
    }

    res.json({
      success: true,
      segments
    });

  } catch (error) {
    console.error('❌ [Generate Audio Segments Error]');

    createdTempFiles.forEach(f => {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    });

    res.status(500).json({ success: false, error: 'Gagal membuat segmen audio' });
  }
});

// Endpoint 3: Generate & Merge Audio (Protected)
app.post('/api/generate-full-podcast', requireAuth, async (req, res) => {
  const tempFiles = [];
  const reqId = crypto.randomUUID();
  const listFilePath = path.resolve(process.cwd(), `concat_list_${reqId}.txt`);
  const outputPath = path.resolve(process.cwd(), `full_podcast_${reqId}.mp3`);

  const cleanAllTemp = () => {
    tempFiles.forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {} });
    if (fs.existsSync(listFilePath)) try { fs.unlinkSync(listFilePath); } catch (e) {}
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (e) {}
  };

  try {
    const { podcast_script } = req.body;

    if (!podcast_script || !Array.isArray(podcast_script) || podcast_script.length === 0) {
      return res.status(400).json({ success: false, error: 'Array podcast_script wajib diisi!' });
    }

    for (let i = 0; i < podcast_script.length; i++) {
      const item = podcast_script[i];
      if (!item || !item.text) continue;

      const selectedVoice = (item.speaker === 'Rian') ? 'id-ID-ArdiNeural' : 'id-ID-GadisNeural';

      const tts = new EdgeTTS({
        voice: selectedVoice,
        lang: 'id-ID',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 30000
      });

      const tempPath = path.resolve(process.cwd(), `temp_${i}_${crypto.randomUUID()}.mp3`);

      await new Promise(r => setTimeout(r, 150));

      try {
        await tts.ttsPromise(item.text, tempPath);
        tempFiles.push(tempPath);
      } catch (ttsError) {
        console.error(`❌ [TTS Full] Segmen ${i} gagal`);
        throw ttsError;
      }
    }

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
        res.sendFile(outputPath, () => {
          cleanAllTemp();
        });
      })
      .on('error', (err) => {
        console.error('❌ [FFmpeg Error]');
        cleanAllTemp();
        res.status(500).json({ success: false, error: 'Gagal menggabungkan audio podcast' });
      })
      .run();

  } catch (error) {
    console.error('❌ [Full Podcast Error]');
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