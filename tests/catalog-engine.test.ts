import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { allFilters, categories, filterCatalog, judge, parseCatalog, scripts } from '../src/catalog/catalog.ts';
import {
  baseProbabilities, initialState, localDate, pickQuestion, recordResult, resetProgress, showQuestion,
} from '../src/engine/engine.ts';

const catalog = parseCatalog(readFileSync(new URL('../kana-loop-catalog-v1.0.csv', import.meta.url), 'utf8'));
const byId = new Map(catalog.map((kana) => [kana.id, kana]));

function seeded(seed = 0x475f) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test('catalog has 208 unique questions and matches every pair and answer in the spec', () => {
  assert.equal(byId.size, 208);
  assert.equal(catalog.length, 208);
  for (const script of scripts) {
    assert.deepEqual(categories.map((category) => catalog.filter((kana) =>
      kana.category === category && kana.script === script).length), [46, 20, 5, 33]);
  }
  const spec = readFileSync(new URL('../kana-loop-spec-v1.0.md', import.meta.url), 'utf8');
  let pairs = 0;
  for (const line of spec.split('\n').filter((line) => line.startsWith('| '))) {
    const [hiragana, katakana, category, gyou, dan, ko, romaji] = line.slice(1, -1).split('|').map((cell) => cell.trim());
    if (!categories.some((value) => value === category)) continue;
    pairs++;
    for (const [id, exactKana] of [[`h:${hiragana}`, hiragana], [`k:${katakana}`, katakana]]) {
      const item = byId.get(id)!;
      assert.equal(item.kana, exactKana);
      assert.deepEqual([item.category, item.gyou, item.dan], [category, gyou, dan]);
      assert.deepEqual(item.acceptedKo, ko.split(', '));
      assert.deepEqual(item.acceptedRomaji, romaji.split(', '));
      assert.equal(item.primaryKo, item.acceptedKo[0]);
      assert.equal(item.primaryRomaji, item.acceptedRomaji[0]);
      for (const answer of [...item.acceptedKo, ...item.acceptedRomaji]) assert.equal(judge(item, answer), true);
      assert.equal(judge(item, exactKana), false);
    }
  }
  assert.equal(pairs, 104);
});

test('answer normalization handles whitespace, ASCII case and NFC without fuzzy matches', () => {
  const item = byId.get('h:し')!;
  assert.equal(judge(item, '  SI '), true);
  assert.equal(judge(item, '시'.normalize('NFD')), true);
  assert.equal(judge(item, 'ＳＩ'), false);
  assert.equal(judge(item, 'she'), false);
  assert.equal(judge(item, ' \n '), null);
});

test('scope intersects category, row and vowel with the special nasal row rule', () => {
  const filters = allFilters();
  const filter = () => filterCatalog(catalog, filters, () => true).map(({ id }) => id);
  assert.equal(filter().length, 208);
  filters.dan = ['u'];
  assert.ok(!filter().includes('h:ん'));
  filters.gyou = ['n'];
  assert.deepEqual(filter(), ['h:ん', 'k:ン']);
  filters.script = ['hiragana'];
  filters.gyou = ['ha'];
  filters.category = ['semi', 'contracted'];
  assert.deepEqual(filter(), ['h:ぷ', 'h:ひゅ', 'h:びゅ', 'h:ぴゅ']);
  filters.category = ['contracted'];
  filters.dan = ['i'];
  assert.deepEqual(filter(), []);
});

test('cold start is uniform and approximately 65% of regular questions favor unanswered items', () => {
  const pool = catalog.slice(0, 10);
  const state = initialState();
  const random = seeded();
  const frequencies = new Map<string, number>();
  for (let i = 0; i < 40_000; i++) {
    const { id } = pickQuestion(pool, state, random)!;
    frequencies.set(id, (frequencies.get(id) ?? 0) + 1);
  }
  assert.equal(frequencies.size, pool.length);
  for (const frequency of frequencies.values()) assert.ok(Math.abs(frequency / 40_000 - 0.1) < 0.006);

  for (const kana of pool.slice(1)) {
    const question = { id: kana.id, review: false };
    showQuestion(state, question);
    recordResult(state, question, true);
  }
  const regularChance = baseProbabilities(pool, state).get(pool[0].id)!
    / pool.slice(0, -2).reduce((total, { id }) => total + baseProbabilities(pool, state).get(id)!, 0);
  let unanswered = 0;
  for (let i = 0; i < 25_000; i++) unanswered += Number(pickQuestion(pool, state, random)!.id === pool[0].id);
  assert.ok(Math.abs(unanswered / 25_000 - (0.65 + 0.35 * regularChance)) < 0.01);
});

test('adaptation favors historically missed questions while keeping easy questions eligible', () => {
  const pool = catalog.slice(0, 12);
  const state = initialState();
  const hard = { id: pool[0].id, review: false };
  const easy = { id: pool[1].id, review: false };
  for (let i = 0; i < 15; i++) {
    for (const kana of pool) {
      const question = { id: kana.id, review: false };
      showQuestion(state, question);
      recordResult(state, question, kana.id !== hard.id);
    }
  }
  assert.ok(baseProbabilities(pool, state).get(hard.id)! > baseProbabilities(pool, state).get(easy.id)!);
  delete state.reviewQueue[hard.id];
  const counts = new Map<string, number>();
  const random = seeded();
  for (let i = 0; i < 20_000; i++) {
    const question = pickQuestion(pool, state, random)!;
    assert.ok(!state.appMeta.recentQuestions.slice(-2).some((last) => last.id === question.id));
    counts.set(question.id, (counts.get(question.id) ?? 0) + 1);
    showQuestion(state, question);
  }
  assert.equal(counts.size, pool.length);
  assert.ok(counts.get(hard.id)! > counts.get(easy.id)!);
});

test('small candidate sets remain usable and skipping does not advance an answer-based due date', () => {
  for (const size of [1, 2, 3]) {
    const state = initialState();
    const pool = catalog.slice(0, size);
    const random = seeded(size);
    for (let i = 0; i < 100; i++) {
      const question = pickQuestion(pool, state, random)!;
      if (size === 3) assert.notEqual(question.id, state.appMeta.recentQuestions.at(-1)?.id);
      showQuestion(state, question);
      recordResult(state, question, 'skip');
    }
    assert.equal(state.appMeta.answeredCount, 0);
    assert.equal(Object.values(state.progress).reduce((sum, record) => sum + record.skipped, 0), 100);
    assert.ok(Object.values(state.progress).every((record) => record.attempts === 0));
  }
  const state = initialState();
  assert.equal(pickQuestion([], state), null);
  const pool = catalog.slice(0, 2);
  showQuestion(state, { id: pool[0].id, review: false });
  const random = seeded();
  let repeats = 0;
  for (let i = 0; i < 10_000; i++) repeats += Number(pickQuestion(pool, state, random)!.id === pool[0].id);
  assert.ok(Math.abs(repeats / 10_000 - 0.2) < 0.02);
});

test('overdue reviews respect the scope and quota, and re-misses are scheduled 3–7 answers later', () => {
  const pool = catalog.slice(0, 8);
  const state = initialState();
  const mistaken = { id: pool[7].id, review: false };
  showQuestion(state, mistaken);
  recordResult(state, mistaken, false, new Date(), () => 0);
  assert.equal(state.reviewQueue[mistaken.id].dueAfter, 4);
  for (const kana of pool.slice(0, 3)) {
    const question = { id: kana.id, review: false };
    showQuestion(state, question);
    recordResult(state, question, true);
  }
  assert.equal(pickQuestion(pool.slice(0, 7), state)?.review, false);
  const review = pickQuestion(pool, state)!;
  assert.deepEqual(review, { ...mistaken, review: true });
  showQuestion(state, review);
  recordResult(state, review, false, new Date(), () => 0.999);
  assert.equal(state.reviewQueue[mistaken.id].dueAfter, 12);
  assert.equal(state.reviewQueue[mistaken.id].consecutiveReviewFailures, 1);
  for (let i = 0; i < 7; i++) {
    const question = { id: pool[i].id, review: i < 4 };
    showQuestion(state, question);
    recordResult(state, question, true);
  }
  assert.equal(pickQuestion(pool, state)?.review, false);
  assert.equal(pickQuestion(pool.slice(5), state)?.id, mistaken.id);
  showQuestion(state, review);
  recordResult(state, review, true);
  assert.equal(state.reviewQueue[mistaken.id], undefined);
});

test('scope reset updates daily counts using the date at the time of each answer', () => {
  const state = initialState();
  const first = { id: 'h:あ', review: false };
  const second = { id: 'k:ア', review: false };
  const before = new Date(2026, 10, 22, 23, 59);
  const after = new Date(2026, 10, 23, 0, 1);
  for (const [question, time, result] of [[first, before, false], [second, before, true], [first, after, 'skip']] as const) {
    showQuestion(state, question);
    recordResult(state, question, result, time);
  }
  resetProgress(state, new Set([first.id]));
  assert.deepEqual(Object.keys(state.dailyStats), [localDate(before)]);
  assert.equal(state.dailyStats[localDate(before)].attempts, 1);
  assert.equal(state.dailyStats[localDate(before)].wrong, 0);
  assert.equal(state.appMeta.answeredCount, 2);
  assert.equal(state.progress[first.id], undefined);
  assert.equal(state.reviewQueue[first.id], undefined);
});
