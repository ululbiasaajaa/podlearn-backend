// Helper murni (tanpa Express/Supabase/Gemini) supaya bisa dites dengan
// `node --test` tanpa perlu env var atau server jalan.

// Whitelist depth yang valid. Backend TIDAK PERNAH percaya value depth dari
// frontend mentah-mentah -- kalau kosong/typo/nilai aneh, fallback ke
// 'balanced'.
export const VALID_DEPTHS = ['concise', 'balanced', 'deep'];

export function resolveDepth(value) {
  return VALID_DEPTHS.includes(value) ? value : 'balanced';
}

// Ambil segmen yang sedang diputar + maksimal 3 segmen sebelumnya, sebagai
// konteks pertanyaan ke Tutor AI.
export function getContextForQuestion(podcastScript, currentIndex) {
  if (!Array.isArray(podcastScript) || podcastScript.length === 0) return [];

  const safeIndex = Math.min(Math.max(0, currentIndex), podcastScript.length - 1);
  const startIndex = Math.max(0, safeIndex - 3);

  return podcastScript.slice(startIndex, safeIndex + 1);
}
