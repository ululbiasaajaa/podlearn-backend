// Logika kuis frontend ada di dalam index.html (single-file frontend).
// Test ini mengambil blok yang ditandai <quiz-review-logic> ... </quiz-review-logic>
// lalu menjalankannya di sandbox node:vm -- jadi yang dites adalah kode
// yang SAMA PERSIS dengan yang jalan di browser, tanpa build step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/\/\/ <quiz-review-logic>([\s\S]*?)\/\/ <\/quiz-review-logic>/);
assert.ok(match, 'Blok <quiz-review-logic> tidak ditemukan di index.html');

const context = {};
vm.runInNewContext(
  `${match[1]}
  exported = { extractOptionKey, isAnswerMatch, isChosenAnswerCorrect, classifyAnswer, resolveScriptIndex, buildQuizReview };`,
  context
);
const {
  extractOptionKey, isAnswerMatch, isChosenAnswerCorrect, classifyAnswer, resolveScriptIndex, buildQuizReview
} = context.exported;

const options = ['A. Hati', 'B. Ginjal', 'C. Paru', 'D. Kulit'];

test('extractOptionKey: pakai huruf di depan opsi, fallback ke urutan', () => {
  assert.equal(extractOptionKey('B. Ginjal', 0), 'B');
  assert.equal(extractOptionKey('c) Paru', 0), 'C');
  assert.equal(extractOptionKey('Tanpa huruf', 3), 'D');
});

test('isAnswerMatch: answer berupa huruf saja', () => {
  const q = { options, answer: 'B' };
  assert.equal(isAnswerMatch(q, 'B. Ginjal', 'B'), true);
  assert.equal(isAnswerMatch(q, 'A. Hati', 'A'), false);
});

test('isAnswerMatch: answer berupa teks lengkap (format lama Gemini)', () => {
  const q = { options, answer: 'B. Ginjal' };
  assert.equal(isAnswerMatch(q, 'B. Ginjal', 'B'), true);
  assert.equal(isAnswerMatch(q, 'C. Paru', 'C'), false);
});

test('isChosenAnswerCorrect: kunci yang tidak ada di opsi dianggap salah', () => {
  const q = { options, answer: 'A' };
  assert.equal(isChosenAnswerCorrect(q, 'A'), true);
  assert.equal(isChosenAnswerCorrect(q, 'B'), false);
  assert.equal(isChosenAnswerCorrect(q, 'Z'), false);
  assert.equal(isChosenAnswerCorrect(q, undefined), false);
});

test('classifyAnswer: 4 kombinasi benar/salah x yakin/ragu', () => {
  assert.equal(classifyAnswer(true, 'sure'), 'mastered');
  assert.equal(classifyAnswer(true, 'unsure'), 'lucky');
  assert.equal(classifyAnswer(false, 'unsure'), 'gap');
  assert.equal(classifyAnswer(false, 'sure'), 'misconception');
  // tanpa data keyakinan diperlakukan sebagai ragu
  assert.equal(classifyAnswer(true, undefined), 'lucky');
});

test('resolveScriptIndex: tanpa interjection, index sama', () => {
  const script = [{}, {}, {}];
  assert.equal(resolveScriptIndex(script, 0), 0);
  assert.equal(resolveScriptIndex(script, 2), 2);
});

test('resolveScriptIndex: segmen "nyela" yang disisipkan dilewati', () => {
  const script = [
    { text: 's0' },
    { text: 's1' },
    { text: 'rian nyela', isInterjection: true },
    { text: 'maya jawab', isInterjection: true },
    { text: 's2' }
  ];
  assert.equal(resolveScriptIndex(script, 1), 1);
  assert.equal(resolveScriptIndex(script, 2), 4);
});

test('resolveScriptIndex: index tidak valid jadi null', () => {
  assert.equal(resolveScriptIndex([{}, {}], 5), null);
  assert.equal(resolveScriptIndex([{}, {}], -1), null);
  assert.equal(resolveScriptIndex([{}, {}], null), null);
  assert.equal(resolveScriptIndex(null, 0), null);
});

test('buildQuizReview: hitung kategori, urutkan prioritas, kelompokkan konsep', () => {
  const quiz = [
    { question: 'Q1', options, answer: 'A', concept: 'Metabolisme', source_segment: 3 },   // benar, yakin -> mastered
    { question: 'Q2', options, answer: 'B', concept: 'Ekskresi', source_segment: 5 },      // benar, ragu -> lucky
    { question: 'Q3', options, answer: 'A', concept: 'metabolisme', source_segment: 4 },   // salah, yakin -> misconception
    { question: 'Q4', options, answer: 'C', concept: 'Metabolisme' },                      // salah, ragu -> gap
    { question: 'Q5', options, answer: 'D' }                                               // salah, yakin, tanpa concept (podcast lama)
  ];
  const answers = { 0: 'A', 1: 'B', 2: 'B', 3: 'A', 4: 'A' };
  const confidences = { 0: 'sure', 1: 'unsure', 2: 'sure', 3: 'unsure', 4: 'sure' };

  const review = buildQuizReview(quiz, answers, confidences);

  assert.equal(review.score, 2);
  assert.equal(review.total, 5);
  assert.deepEqual({ ...review.counts }, { mastered: 1, lucky: 1, gap: 1, misconception: 2 });

  // misconception dulu (urut nomor soal), lalu gap, lalu lucky
  assert.deepEqual(review.toReview.map(item => item.questionIndex), [2, 4, 3, 1]);

  // "Metabolisme" & "metabolisme" digabung (muncul 2x), Ekskresi 1x
  assert.deepEqual([...review.weakConcepts], ['metabolisme', 'Ekskresi']);

  // source_segment dibawa; soal tanpa source_segment jadi null
  assert.equal(review.toReview[0].sourceSegment, 4);
  assert.equal(review.toReview[1].sourceSegment, null);
});

test('buildQuizReview: semua benar & yakin -> tidak ada yang perlu dicek ulang', () => {
  const quiz = [{ question: 'Q1', options, answer: 'A', concept: 'X', source_segment: 0 }];
  const review = buildQuizReview(quiz, { 0: 'A' }, { 0: 'sure' });
  assert.equal(review.toReview.length, 0);
  assert.equal(review.weakConcepts.length, 0);
});
