// ============================================================
// 📏 BATAS PANJANG MATERI
// ============================================================
// Sebelumnya materi dipotong DIAM-DIAM di 3 tempat dengan angka beda-beda
// (extract 8000, generate 12000, Tutor AI 8000) -- user upload PDF 40
// halaman, yang kebahas cuma ~3-4 halaman awal, dan nggak ada yang ngasih
// tahu. Sekarang semua batas ada di sini, dan setiap pemotongan dilaporkan
// (truncated + panjang asli) supaya bisa ditampilkan jujur ke user.
//
// Kenapa input tetap dibatasi walau Gemini sanggup baca jauh lebih panjang:
// yang membatasi adalah OUTPUT (naskah + 10 kuis maks ~8k token). Satu
// podcast memang nggak bisa mencakup dokumen panjang secara utuh.

// Batas materi yang benar-benar dibahas podcast & dipakai Tutor AI.
// ⚠️ Angka yang sama diduplikasi di index.html (MAX_MATERIAL_CHARS) untuk
// counter karakter di textarea -- kalau diubah, ubah dua-duanya.
export const MAX_MATERIAL_CHARS = 12000;

// Batas pengaman hasil ekstraksi file. Bukan batas materi -- cuma supaya
// payload ke browser (dan balik ke backend, limit JSON 5mb) tetap wajar.
// User tetap lihat teks lengkap sampai batas ini dan bisa memilih sendiri
// bagian mana yang mau dibahas.
export const MAX_EXTRACT_CHARS = 200000;

// Potong teks ke maxChars, sambil melaporkan apakah ada yang terpotong.
export function limitText(text, maxChars) {
  const value = typeof text === 'string' ? text.trim() : '';
  const truncated = value.length > maxChars;
  return {
    text: truncated ? value.substring(0, maxChars) : value,
    truncated,
    originalLength: value.length
  };
}

// Membersihkan karakter non-printable / binary liar hasil parser PDF/PPTX.
export function cleanExtractedText(rawText) {
  return (rawText || '')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
    .trim();
}
