import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuiz, normalizeSourceSegment, normalizeConcept } from '../lib/quiz.js';

test('normalizeSourceSegment: index valid diteruskan', () => {
  assert.equal(normalizeSourceSegment(0, 10), 0);
  assert.equal(normalizeSourceSegment(9, 10), 9);
  assert.equal(normalizeSourceSegment('3', 10), 3);
});

test('normalizeSourceSegment: di luar jangkauan / bukan bilangan bulat jadi null', () => {
  for (const value of [10, -1, 2.5, 'abc', '', null, undefined, NaN]) {
    assert.equal(normalizeSourceSegment(value, 10), null, `value=${value}`);
  }
});

test('normalizeSourceSegment: naskah kosong selalu null', () => {
  assert.equal(normalizeSourceSegment(0, 0), null);
});

test('normalizeConcept: trim, kosong jadi null, dibatasi 80 karakter', () => {
  assert.equal(normalizeConcept('  Farmakokinetik  '), 'Farmakokinetik');
  assert.equal(normalizeConcept('   '), null);
  assert.equal(normalizeConcept(42), null);
  assert.equal(normalizeConcept('x'.repeat(200)).length, 80);
});

test('normalizeQuiz: field lama dipertahankan, field baru divalidasi', () => {
  const quiz = [
    { question: 'Q1', options: ['A. a', 'B. b'], answer: 'A', concept: ' Absorpsi ', source_segment: 2 },
    { question: 'Q2', options: ['A. a', 'B. b'], answer: 'B', concept: '', source_segment: 99 },
    { question: 'Q3', options: ['A. a', 'B. b'], answer: 'A' }
  ];
  const result = normalizeQuiz(quiz, 5);
  assert.deepEqual(result[0], { question: 'Q1', options: ['A. a', 'B. b'], answer: 'A', concept: 'Absorpsi', source_segment: 2 });
  assert.equal(result[1].concept, null);
  assert.equal(result[1].source_segment, null);
  assert.equal(result[2].concept, null);
  assert.equal(result[2].source_segment, null);
});

test('normalizeQuiz: bukan array menghasilkan array kosong', () => {
  assert.deepEqual(normalizeQuiz(undefined, 5), []);
});
