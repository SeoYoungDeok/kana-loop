import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, recordResult, showQuestion } from '../src/engine/engine.ts';
import { createBackup, parseBackup } from '../src/storage/backup.ts';
import { loadState, openDatabase, saveState, StaleStateError } from '../src/storage/database.ts';

const date = '2026-11-22T04:00:00.000Z';
const question = { id: 'h:あ', review: false };
const ids = new Set([question.id]);

function sample() {
  const state = initialState();
  showQuestion(state, question);
  recordResult(state, question, false, new Date(date), () => 0);
  state.settings.filters.script = ['hiragana'];
  return state;
}

test('a committed answer survives reopening, and one Undo restores all stores', async () => {
  const original = initialState();
  showQuestion(original, question);
  const after = sample();
  const db = await openDatabase('restore');
  const first = await saveState(db, initialState(), original, 0);
  const revision = await saveState(db, original, after, first);
  db.close();

  const reopened = await openDatabase('restore');
  assert.deepEqual(await loadState(reopened), { state: after, revision });
  await saveState(reopened, after, original, revision);
  assert.deepEqual(await loadState(reopened), { state: original, revision: revision + 1 });
  reopened.close();
});

test('revision checks reject a competing writer without changing existing records', async () => {
  const db = await openDatabase('concurrent');
  const otherTab = await openDatabase('concurrent');
  const original = initialState();
  const state = sample();
  const revision = await saveState(db, original, state, 0);
  await assert.rejects(saveState(otherTab, original, original, 0), StaleStateError);
  assert.deepEqual(await loadState(otherTab), { state, revision });
  db.close();
  otherTab.close();
});

test('a partial write failure rolls back progress, daily totals, queue and revision', async () => {
  const db = await openDatabase('abort');
  const original = initialState();
  const state = sample();
  // IndexedDB rejects a function in the review store after earlier writes are queued.
  Object.assign(state.reviewQueue[question.id], { invalid: () => true });
  await assert.rejects(saveState(db, original, state, 0));
  assert.deepEqual(await loadState(db), { state: original, revision: 0 });
  db.close();
});

test('JSON backup restores a whole state and rejects bad counts, dates, IDs and filters', () => {
  const state = sample();
  assert.deepEqual(parseBackup(createBackup(state, date), ids), state);
  const unknownQuestion = sample();
  unknownQuestion.appMeta.recentQuestions = [];
  assert.throws(() => parseBackup(createBackup(unknownQuestion, date), new Set()), /카탈로그/);
  state.progress[question.id].correct++;
  assert.throws(() => parseBackup(createBackup(state, date), ids), /횟수/);
  state.progress[question.id].correct--;
  const [valid] = Object.keys(state.dailyStats);
  state.dailyStats['2026-02-30'] = state.dailyStats[valid];
  delete state.dailyStats[valid];
  assert.throws(() => parseBackup(createBackup(state, date), ids), /일별/);
  const invalid = JSON.parse(createBackup(sample(), date));
  invalid.settings.filters.dan = ['u', 'u'];
  assert.throws(() => parseBackup(JSON.stringify(invalid), ids), /학습 범위/);
});
