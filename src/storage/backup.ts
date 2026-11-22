import { categories, rows, scripts, vowels } from '../catalog/catalog.ts';
import { catalogVersion, schemaVersion, totals, type Counts, type State } from '../engine/engine.ts';

export const backupSchemaVersion = 1;

export function createBackup(state: State, exportedAt: string): string {
  return JSON.stringify({
    app: 'kana-loop', backupSchemaVersion, catalogVersion, exportedAt, ...state,
  }, null, 2);
}

type RecordValue = Record<string, unknown>;
const isObject = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
const selection = (value: unknown, options: readonly string[]) => Array.isArray(value)
  && value.every((item) => options.includes(item)) && new Set(value).size === value.length;

function invalid(message: string): never {
  throw new Error(message);
}

function counts(value: unknown): Counts {
  if (!isObject(value)) invalid('횟수 데이터 형식이 올바르지 않습니다.');
  const { attempts, correct, wrong, skipped } = value;
  if (!isCount(attempts) || !isCount(correct) || !isCount(wrong) || !isCount(skipped)
    || attempts !== correct + wrong) invalid('시도·정답·오답 횟수가 일치하지 않습니다.');
  return { attempts, correct, wrong, skipped };
}

const sameCounts = (a: Counts, b: Counts) =>
  a.attempts === b.attempts && a.correct === b.correct && a.wrong === b.wrong && a.skipped === b.skipped;

export function parseBackup(text: string, ids: ReadonlySet<string>): State {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid('JSON 파일을 읽을 수 없습니다.');
  }

  if (!isObject(value) || value.app !== 'kana-loop' || value.backupSchemaVersion !== backupSchemaVersion
    || value.catalogVersion !== catalogVersion || !isInstant(value.exportedAt)) {
    invalid('지원하는 Kana Loop 백업 형식이 아닙니다.');
  }
  const { settings, progress, dailyStats, reviewQueue, appMeta } = value;
  if (!isObject(settings) || !isObject(progress) || !isObject(dailyStats) || !isObject(reviewQueue)
    || !isObject(appMeta)) invalid('백업에 필요한 데이터가 빠져 있습니다.');

  const { filters, lastPage } = settings;
  if (!isObject(filters) || !selection(filters.script, scripts) || !selection(filters.category, categories)
    || !selection(filters.gyou, rows) || !selection(filters.dan, vowels) || typeof filters.weakOnly !== 'boolean'
    || (lastPage !== 'quiz' && lastPage !== 'settings' && lastPage !== 'stats')) {
    invalid('학습 범위 또는 화면 설정이 올바르지 않습니다.');
  }

  const { questionIndex, answeredCount, lastBackupAt, streak, recentQuestions } = appMeta;
  if (appMeta.schemaVersion !== schemaVersion || appMeta.catalogVersion !== catalogVersion
    || !isCount(questionIndex) || !isCount(answeredCount) || answeredCount > questionIndex
    || !isCount(streak) || streak > answeredCount || (lastBackupAt !== null && !isInstant(lastBackupAt))
    || !Array.isArray(recentQuestions) || recentQuestions.length > Math.min(20, questionIndex)
    || recentQuestions.some((item) => !isObject(item) || typeof item.id !== 'string'
      || !ids.has(item.id) || typeof item.review !== 'boolean')) {
    invalid('출제 또는 백업 정보가 올바르지 않습니다.');
  }

  const validatedProgress: State['progress'] = {};
  for (const [id, item] of Object.entries(progress)) {
    if (!ids.has(id) || !isObject(item)) invalid('카탈로그에 없는 문항 정보가 있습니다.');
    const validatedCounts = counts(item);
    const { attempts, correct, wrong } = validatedCounts;
    const { lastSeenIndex, lastAnsweredAt, recentResults, streak } = item;
    if (!isCount(streak) || streak > correct || !Array.isArray(recentResults)
      || recentResults.length !== Math.min(10, attempts) || recentResults.some((result) => typeof result !== 'boolean')
      || recentResults.filter(Boolean).length > correct || recentResults.filter((result) => !result).length > wrong
      || (attempts ? !isInstant(lastAnsweredAt) : lastAnsweredAt !== null)
      || (!isCount(lastSeenIndex) || lastSeenIndex < 1 || lastSeenIndex > questionIndex)) {
      invalid('문항별 학습 기록이 올바르지 않습니다.');
    }
    validatedProgress[id] = { ...validatedCounts, streak, lastSeenIndex, lastAnsweredAt: lastAnsweredAt as string | null, recentResults };
  }

  const validatedDaily: State['dailyStats'] = {};
  const dailyByKana: Record<string, Counts> = {};
  for (const [date, item] of Object.entries(dailyStats)) {
    if (!dateKeyPattern.test(date) || !isInstant(`${date}T00:00:00.000Z`)
      || !isObject(item) || !isObject(item.byKana)) invalid('일별 학습 기록이 올바르지 않습니다.');
    const byKana: Record<string, Counts> = {};
    for (const [id, detail] of Object.entries(item.byKana)) {
      if (!ids.has(id) || !validatedProgress[id]) invalid('일별 기록에 알 수 없는 문항이 있습니다.');
      byKana[id] = counts(detail);
      dailyByKana[id] = totals([byKana[id], ...(dailyByKana[id] ? [dailyByKana[id]] : [])]);
    }
    const daily = counts(item);
    if (!sameCounts(daily, totals(Object.values(byKana)))) invalid('일별 합계가 문항별 기록과 일치하지 않습니다.');
    validatedDaily[date] = { ...daily, byKana };
  }

  for (const [id, item] of Object.entries(validatedProgress)) {
    if (!sameCounts(item, dailyByKana[id] ?? totals([]))) invalid('누적 기록이 일별 합계와 일치하지 않습니다.');
  }
  if (totals(Object.values(validatedProgress)).attempts > answeredCount) invalid('누적 응답 수가 올바르지 않습니다.');

  const validatedReviews: State['reviewQueue'] = {};
  for (const [id, item] of Object.entries(reviewQueue)) {
    if (!ids.has(id) || !validatedProgress[id]?.wrong || !isObject(item)) invalid('복습 문항이 올바르지 않습니다.');
    const { dueAfter, createdAt, consecutiveReviewFailures } = item;
    if (!isCount(dueAfter) || !isCount(createdAt) || createdAt < 1 || createdAt > answeredCount
      || dueAfter - createdAt < 3 || dueAfter - createdAt > 7 || !isCount(consecutiveReviewFailures)
      || consecutiveReviewFailures > validatedProgress[id].wrong) invalid('복습 일정이 올바르지 않습니다.');
    validatedReviews[id] = { dueAfter, createdAt, consecutiveReviewFailures };
  }
  return {
    settings: { filters: filters as unknown as State['settings']['filters'], lastPage },
    progress: validatedProgress, dailyStats: validatedDaily, reviewQueue: validatedReviews,
    appMeta: {
      schemaVersion, catalogVersion, questionIndex, answeredCount, lastBackupAt, streak,
      recentQuestions: recentQuestions.map(({ id, review }) => ({ id, review })),
    },
  };
}
