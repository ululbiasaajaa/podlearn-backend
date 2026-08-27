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
const pdfParse = require('pdf-parse');

// Single Source of Truth untuk Model Gemini
const GEMINI_MODEL = 'gemini-3.6-flash';

// Set path FFmpeg Static
ffmpeg.setFfmpegPath(ffmpegInstaller);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Server-side Supabase Client Config
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://egkrbtmszicrsavtrfta.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7Vtbl3pupXGiMy449x-clg_fMoHqKLx';

let supabaseAdmin = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log('✅ [Supabase Admin] Server client terinisialisasi dengan Service Role Key.');
} else {
  console.warn('⚠️ [Supabase Admin] SUPABASE_SERVICE_ROLE_KEY belum di-set. Menggunakan Anon Client Fallback.');
}

function getSupabaseClient() {
  if (supabaseAdmin) return supabaseAdmin;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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

// Serve temporary audio files statically
app.use('/temp-audio', express.static(tempAudioDir));

// Background Cleanup Job: Runs every 10 minutes, deletes files older than 15 minutes
setInterval(() => {
  try {
    const files = fs.readdirSync(tempAudioDir);
    const now = Date.now();
    const maxAgeMs = 15 * 60 * 1000; // 15 minutes

    files.forEach((file) => {
      const filePath = path.join(tempAudioDir, file);
      const stats = fs.statSync(filePath);
      const fileCreatedTime = stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs;
      const fileAge = now - fileCreatedTime;
      if (fileAge > maxAgeMs && fileAge > 60000) {
        fs.unlinkSync(filePath);
        console.log(`🧹 [Cleanup] File temp audio dihapus: ${file}`);
      }
    });
  } catch (err) {
    console.error('❌ [Cleanup Error]:', err);
  }
}, 10 * 60 * 1000);

const upload = multer({ dest: 'uploads/' });

// ============================================
// 🔑 API KEY POOL & ROTATION
// ============================================
const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 0);

if (apiKeys.length === 0) {
  throw new Error('❌ GEMINI_API_KEYS (atau GEMINI_API_KEY) belum di-set di .env');
}

console.log(`🔑 [Key Pool] ${apiKeys.length} API key terdaftar.`);

let currentKeyIndex = 0;

function getAiClient() {
  return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

function rotateKey() {
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  console.warn(`🔄 [Key Rotation] Pindah ke API key index ${currentKeyIndex}`);
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
          console.warn(`⚠️ [Gemini Rate Limit 429] Semua key kena limit. Menunggu ${waitTime / 1000} detik...`);
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

// Endpoint Health Check
app.get('/api/health', (req, res) => {
  res.send('Server PodLearn Backend Aktif!');
});

// Endpoint Extract PDF / TXT
app.post('/api/extract-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });

    const filePath = req.file.path;
    const fileMime = req.file.mimetype;
    const originalName = req.file.originalname.toLowerCase();

    let extractedText = '';

    if (originalName.endsWith('.pdf') || fileMime === 'application/pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      extractedText = pdfData.text;
    } else if (originalName.endsWith('.txt') || fileMime === 'text/plain') {
      extractedText = fs.readFileSync(filePath, 'utf8');
    } else {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Format file tidak didukung.' });
    }

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const trimmedText = extractedText.trim().substring(0, 8000);

    if (!trimmedText) return res.status(400).json({ error: 'File kosong.' });

    res.json({ success: true, text: trimmedText });
  } catch (error) {
    console.error('Error Extracting File:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Gagal membaca dokumen' });
  }
});

// Endpoint 1: Generate Naskah & Quiz
app.post('/api/generate-script', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Teks materi tidak boleh kosong' });

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
${text}
`;

    const response = await callGeminiWithRetry(prompt, { useSchema: true });

    const rawText = response.text || '';
    const parsedData = JSON.parse(rawText);

    res.json({
      success: true,
      data: parsedData,
    });
  } catch (error) {
    console.error('❌ Error Generating Script:', error);
    res.status(500).json({ error: 'Gagal membuat naskah podcast', details: error?.message || error });
  }
});

// Endpoint 2: Generate Audio Per Segment
app.post('/api/generate-audio-segments', async (req, res) => {
  const createdTempFiles = []; // Pelacak temp file terisolasi milik request ini saja

  try {
    const { podcast_script, user_id, podcast_id } = req.body;

    if (!podcast_script || !Array.isArray(podcast_script) || podcast_script.length === 0) {
      return res.status(400).json({ error: 'Array podcast_script wajib diisi!' });
    }

    console.log(`🎙️ [TTS Segments] Memulai pembuatan ${podcast_script.length} file audio segmen...`);
    const segments = [];
    const generatedPodcastId = podcast_id || `pod_${Date.now()}`;
    const clientToUse = getSupabaseClient();

    for (let i = 0; i < podcast_script.length; i++) {
      const item = podcast_script[i];

      let selectedVoice = 'id-ID-ArdiNeural';
      if (item.speaker === 'Maya') {
        selectedVoice = 'id-ID-GadisNeural';
      } else if (item.speaker !== 'Rian') {
        console.warn(`⚠️ Speaker tidak dikenal (${item.speaker}), menggunakan voice default Rian.`);
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
        createdTempFiles.push(absolutePath); // Tandai berkas lokal milik request ini
        console.log(`✅ [TTS Segments] Local temp segmen ${i} (${item.speaker}) berhasil.`);
      } catch (ttsError) {
        console.error(`❌ [TTS Segments] Segmen ${i} (${item.speaker}) gagal:`, ttsError.message);
        throw ttsError;
      }

      if (user_id && clientToUse) {
        try {
          const storagePath = `${user_id}/${generatedPodcastId}/segment_${i}.mp3`;
          const fileBuffer = fs.readFileSync(absolutePath);

          const { error: uploadError } = await clientToUse.storage
            .from('podcast-audio')
            .upload(storagePath, fileBuffer, {
              contentType: 'audio/mpeg',
              upsert: true
            });

          if (!uploadError) {
            const { data: publicUrlData } = clientToUse.storage
              .from('podcast-audio')
              .getPublicUrl(storagePath);

            finalAudioUrl = publicUrlData.publicUrl;
            console.log(`☁️ [Supabase Storage] Segmen ${i} diunggah ke Storage: ${finalAudioUrl}`);

            // 🧹 Pembersihan Seketika: Hapus temp file lokal jika sudah berhasil terunggah
            if (fs.existsSync(absolutePath)) {
              fs.unlinkSync(absolutePath);
              const idx = createdTempFiles.indexOf(absolutePath);
              if (idx > -1) createdTempFiles.splice(idx, 1);
            }
          }
        } catch (stErr) {
          console.warn('⚠️ Skip Supabase Upload (Local Fallback Dipakai):', stErr.message);
        }
      }

      segments.push({
        index: i,
        speaker: item.speaker,
        audioUrl: finalAudioUrl
      });
    }

    console.log(`✅ [TTS Segments] Selesai memproses ${segments.length} segmen.`);
    res.json({
      success: true,
      segments
    });

  } catch (error) {
    console.error('❌ [Generate Audio Segments Error]:', error);
    
    // 🧹 Pembersihan Terisolasi: Hapus hanya temp file yang terdaftar di request ini
    createdTempFiles.forEach(f => {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
    });

    res.status(500).json({ error: 'Gagal membuat segmen audio', details: error?.message || error });
  }
});

// Endpoint 3: Generate & Merge Audio (Full Podcast Existing)
app.post('/api/generate-full-podcast', async (req, res) => {
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
      return res.status(400).json({ error: 'Array podcast_script wajib diisi!' });
    }

    console.log(`🎙️ [TTS] Memulai pemrosesan ${podcast_script.length} dialog audio...`);

    for (let i = 0; i < podcast_script.length; i++) {
      const item = podcast_script[i];
      const selectedVoice = (item.speaker === 'Rian') ? 'id-ID-ArdiNeural' : 'id-ID-GadisNeural';

      const tts = new EdgeTTS({
        voice: selectedVoice,
        lang: 'id-ID',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 30000
      });

      // 🔒 UUID Collision-Safe Naming
      const tempPath = path.resolve(process.cwd(), `temp_${i}_${crypto.randomUUID()}.mp3`);

      await new Promise(r => setTimeout(r, 150));

      try {
        await tts.ttsPromise(item.text, tempPath);
        tempFiles.push(tempPath);
        console.log(`✅ [TTS Full] Segmen ${i} (${item.speaker}) berhasil.`);
      } catch (ttsError) {
        console.error(`❌ [TTS Full] Segmen ${i} (${item.speaker}) gagal:`, ttsError.message);
        throw ttsError;
      }
    }

    const fileListContent = tempFiles
      .map(f => `file '${f.replace(/\\/g, '/')}'`)
      .join('\n');

    fs.writeFileSync(listFilePath, fileListContent);

    console.log('🎵 [FFmpeg] Menggabungkan potongan file audio MP3...');

    ffmpeg()
      .input(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions('-c copy')
      .output(outputPath)
      .on('end', () => {
        console.log('✅ [FFmpeg] Penggabungan Selesai!');
        res.sendFile(outputPath, () => {
          cleanAllTemp();
        });
      })
      .on('error', (err) => {
        console.error('❌ [FFmpeg Error]:', err);
        cleanAllTemp();
        res.status(500).json({ error: 'Gagal menggabungkan audio podcast', details: err.message });
      })
      .run();

  } catch (error) {
    console.error('❌ [Full Podcast Error]:', error);
    cleanAllTemp();
    res.status(500).json({ error: 'Gagal memproses full podcast', details: error.message });
  }
});

// Endpoint 4: Ask Question
app.post('/api/ask-question', async (req, res) => {
  try {
    const { question, currentIndex, podcastScript, sourceMaterial } = req.body;

    if (!question || typeof currentIndex !== 'number' || !podcastScript) {
      return res.status(400).json({ error: 'Parameter question, currentIndex, dan podcastScript wajib diisi' });
    }

    const contextSegments = getContextForQuestion(podcastScript, currentIndex);

    const prompt = `
Bertindaklah sebagai seorang Tutor AI yang ramah, membantu, dan jelas.
Learner sedang mendengarkan podcast edukasi dan menghentikan putaran audio untuk mengajukan pertanyaan.

Materi Sumber Utama (Source Material):
"""
${sourceMaterial || 'Tidak ada teks materi tambahan.'}
"""

Konteks Percakapan Podcast Terakhir Didegar (maksimal 4 segmen):
${JSON.stringify(contextSegments, null, 2)}

Pertanyaan Learner:
"${question}"

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
    console.error('❌ [Ask Question Error]:', error);
    res.status(500).json({ error: 'Gagal memproses pertanyaan', details: error?.message || error });
  }
});

// Endpoint 5: Hapus Podcast (Anti-Crash & Robust Deletion)
app.post('/api/delete-podcast', async (req, res) => {
  try {
    const { podcast_id, user_id } = req.body;

    if (!podcast_id || !user_id) {
      return res.status(400).json({ success: false, error: 'podcast_id dan user_id wajib diisi' });
    }

    const clientToUse = getSupabaseClient();
    const folderPath = `${user_id}/${podcast_id}`;

    // 1. Storage Cleanup (Isolated & Non-Blocking jika folder kosong/tidak ada)
    try {
      const { data: filesList } = await clientToUse.storage
        .from('podcast-audio')
        .list(folderPath);

      if (filesList && filesList.length > 0) {
        const filesToRemove = filesList.map(f => `${folderPath}/${f.name}`);
        await clientToUse.storage
          .from('podcast-audio')
          .remove(filesToRemove);
        console.log(`🧹 Storage cleanup selesai untuk folder: ${folderPath}`);
      }
    } catch (storageErr) {
      console.warn('⚠️ Warning Cleanup Storage (Lanjut hapus DB):', storageErr.message);
    }

    // 2. Database Row Deletion (Mandatory Task)
    const { error: dbError } = await clientToUse
      .from('podcasts')
      .delete()
      .eq('id', podcast_id)
      .eq('user_id', user_id);

    if (dbError) {
      console.error('❌ Gagal hapus DB row:', dbError.message);
      return res.status(500).json({ 
        success: false, 
        error: `Gagal menghapus data podcast dari database: ${dbError.message}` 
      });
    }

    console.log(`✅ Podcast ${podcast_id} milik user ${user_id} berhasil dihapus.`);
    return res.json({ success: true, message: 'Podcast berhasil dihapus.' });

  } catch (err) {
    console.error('❌ Fatal Error pada /api/delete-podcast:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server PodLearn berjalan di http://localhost:${PORT}`);
});