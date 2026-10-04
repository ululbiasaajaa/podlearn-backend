// ============================================================
// 📝 NORMALISASI KUIS HASIL GEMINI
// ============================================================
// Tiap soal kuis sekarang punya 2 field tambahan untuk layar "bedah hasil":
// - concept: konsep yang diuji (dipakai mengelompokkan soal yang salah)
// - source_segment: index segmen podcast_script yang membahas jawabannya
//   (dipakai tombol "dengerin lagi bagian ini")
//
// Output Gemini TIDAK dipercaya mentah-mentah: index segmen bisa di luar
// jangkauan / bukan angka, concept bisa kosong. Field yang tidak valid
// diganti null -- frontend menyembunyikan fitur terkait untuk soal itu,
// bukan crash. Podcast lama (sebelum field ini ada) diperlakukan sama.

export function normalizeSourceSegment(value, scriptLength) {
  const index = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(index) || index < 0 || index >= scriptLength) return null;
  return index;
}

export function normalizeConcept(value) {
  if (typeof value !== 'string') return null;
  const concept = value.trim();
  return concept ? concept.substring(0, 80) : null;
}

export function normalizeQuiz(quiz, scriptLength) {
  if (!Array.isArray(quiz)) return [];
  return quiz.map(item => ({
    ...item,
    concept: normalizeConcept(item?.concept),
    source_segment: normalizeSourceSegment(item?.source_segment, scriptLength)
  }));
}
