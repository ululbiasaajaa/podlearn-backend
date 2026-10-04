import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MATERIAL_CHARS, limitText, cleanExtractedText } from '../lib/material.js';

test('limitText: teks di bawah batas tidak dipotong dan tidak ditandai truncated', () => {
  const result = limitText('  halo dunia  ', 100);
  assert.deepEqual(result, { text: 'halo dunia', truncated: false, originalLength: 10 });
});

test('limitText: teks tepat di batas tidak dianggap terpotong', () => {
  const result = limitText('a'.repeat(50), 50);
  assert.equal(result.truncated, false);
  assert.equal(result.text.length, 50);
});

test('limitText: teks melebihi batas dipotong dan panjang aslinya dilaporkan', () => {
  const result = limitText('a'.repeat(MAX_MATERIAL_CHARS + 500), MAX_MATERIAL_CHARS);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, MAX_MATERIAL_CHARS);
  assert.equal(result.originalLength, MAX_MATERIAL_CHARS + 500);
});

test('limitText: input kosong/bukan string aman (tidak crash)', () => {
  for (const input of [undefined, null, '', 123]) {
    assert.deepEqual(limitText(input, 100), { text: '', truncated: false, originalLength: 0 });
  }
});

test('cleanExtractedText: karakter kontrol diganti spasi, newline dipertahankan', () => {
  assert.equal(cleanExtractedText('a\x00b\x07c\nd'), 'a b c\nd');
});

test('cleanExtractedText: TIDAK lagi memotong teks panjang (pemotongan diatur limitText)', () => {
  const longText = 'x'.repeat(20000);
  assert.equal(cleanExtractedText(longText).length, 20000);
});

test('cleanExtractedText: input kosong menghasilkan string kosong', () => {
  assert.equal(cleanExtractedText(undefined), '');
  assert.equal(cleanExtractedText('   \x00  '), '');
});
