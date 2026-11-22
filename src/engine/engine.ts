import type { Filters, Kana } from '../catalog/catalog.ts';
import { allFilters, filterCatalog } from '../catalog/catalog.ts';

export interface Counts {
  attempts: number;
  correct: number;
  wrong: number;
  skipped: number;
}

export interface Progress extends Counts {
  streak: number;
  recentResults: boolean[];
  lastSeenIndex: number | null;
  lastAnsweredAt: string | null;
}

export interface DailyStats extends Counts {
  byKana: Record<string, Counts>;
}

export interface Review {
  dueAfter: number;
  createdAt: number;
  consecutiveReviewFailures: number;
}

export interface Question {
  id: string;
  review: boolean;
}

export interface Settings {
  filters: Filters;
  lastPage: 'quiz' | 'settings' | 'stats';
}

export interface Meta {
  schemaVersion: number;
  catalogVersion: string;
  questionIndex: number;
  answeredCount: number;
  lastBackupAt: string | null;
  recentQuestions: Question[];
  streak: number;
}

export interface State {
  settings: Settings;
  progress: Record<string, Progress>;
  dailyStats: Record<string, DailyStats>;
  reviewQueue: Record<string, Review>;
  appMeta: Meta;
}

export const catalogVersion = '1.0';
export const schemaVersion = 1;
export const emptyCounts = (): Counts => ({ attempts: 0, correct: 0, wrong: 0, skipped: 0 });

const emptyProgress = (): Progress => ({
  ...emptyCounts(), streak: 0, recentResults: [], lastSeenIndex: null, lastAnsweredAt: null,
});

export function initialState(): State {
  return {
    settings: { filters: allFilters(), lastPage: 'quiz' },
    progress: {}, dailyStats: {}, reviewQueue: {},
    appMeta: {
      schemaVersion, catalogVersion, questionIndex: 0, answeredCount: 0,
      lastBackupAt: null, recentQuestions: [], streak: 0,
    },
  };
}

export function mastery(progress?: Progress): string {
  if (!progress || progress.attempts < 3) return '미평가';
  const accuracy = progress.correct / progress.attempts;
  const recentAccuracy = progress.recentResults.filter(Boolean).length / progress.recentResults.length;
  if (accuracy >= 0.9 && recentAccuracy >= 0.9 && progress.streak >= 5) return '숙련';
  if (accuracy >= 0.75 && recentAccuracy >= 0.75) return '안정';
  return '학습 중';
}

export function weakness(progress?: Progress): number {
  if (!progress || progress.wrong === 0) return 0;
  const recentWrong = progress.recentResults.filter((result) => !result).length;
  return (progress.wrong + 1) / (progress.attempts + 2)
    + (recentWrong + 1) / (progress.recentResults.length + 2);
}

export function questionPool(catalog: readonly Kana[], state: State): Kana[] {
  return filterCatalog(catalog, state.settings.filters, (id) => {
    const progress = state.progress[id];
    return weakness(progress) > 0 && mastery(progress) !== '숙련';
  });
}

export function baseProbabilities(pool: readonly Kana[], state: State): Map<string, number> {
  const size = pool.length;
  if (!size) return new Map();
  const attempts = pool.reduce((total, kana) => total + (state.progress[kana.id]?.attempts ?? 0), 0);
  const lambda = Math.min(0.8, 0.8 * attempts / (3 * size));
  const weights = pool.map(({ id }) => {
    const progress = state.progress[id] ?? emptyProgress();
    const error = (progress.wrong + 1) / (progress.attempts + 2);
    const recentWrong = progress.recentResults.filter((result) => !result).length;
    const recentError = (recentWrong + 1) / (progress.recentResults.length + 2);
    const distance = progress.lastSeenIndex === null ? 0 : Math.min(1, Math.max(0,
      (state.appMeta.questionIndex + 1 - progress.lastSeenIndex - 1) / Math.max(4, Math.ceil(0.75 * size))));
    const weight = 1 + 2 * error + 1.2 * recentError + 0.4 * distance - 0.1 * Math.min(progress.streak, 5);
    return Math.min(5, Math.max(0.7, weight));
  });
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return new Map(pool.map(({ id }, i) => [id, (1 - lambda) / size + lambda * weights[i] / sum]));
}

export function pickQuestion(pool: readonly Kana[], state: State, random = Math.random): Question | null {
  if (pool.length === 0) return null;
  const { appMeta, progress, reviewQueue } = state;
  const size = pool.length;
  const recentLimit = size >= 5 ? 2 : size >= 3 ? 1 : 0;
  const blocked = new Set(recentLimit ? appMeta.recentQuestions.slice(-recentLimit).map(({ id }) => id) : []);
  const recent = appMeta.recentQuestions.at(-1)?.id;
  const last19Reviews = appMeta.recentQuestions.slice(-19).filter((question) => question.review).length;

  if (size <= 3 || last19Reviews < 5) {
    const due = pool.filter(({ id }) => reviewQueue[id]?.dueAfter <= appMeta.answeredCount
      && !blocked.has(id)).sort((a, b) => reviewQueue[a.id].dueAfter - reviewQueue[b.id].dueAfter
      || reviewQueue[a.id].createdAt - reviewQueue[b.id].createdAt);
    if (due.length) return { id: due[0].id, review: true };
  }

  const withoutRecent = pool.filter(({ id }) => !blocked.has(id));
  const allowed = withoutRecent.length ? withoutRecent : pool;
  const withoutReserved = allowed.filter(({ id }) => !reviewQueue[id]);
  const regular = withoutReserved.length ? withoutReserved : allowed;
  const unanswered = regular.filter(({ id }) => !progress[id]?.attempts);
  const probabilities = baseProbabilities(pool, state);
  const useUnanswered = unanswered.length > 0 && random() < 0.65;
  const candidates = useUnanswered ? unanswered : regular;
  const weight = ({ id }: Kana) => (useUnanswered ? 1 : probabilities.get(id)!)
    * (size === 2 && recent === id ? 0.25 : 1);
  let draw = random() * candidates.reduce((sum, kana) => sum + weight(kana), 0);
  for (const kana of candidates) {
    draw -= weight(kana);
    if (draw < 0) return { id: kana.id, review: false };
  }
  return { id: candidates[candidates.length - 1].id, review: false };
}

export function showQuestion(state: State, question: Question): void {
  const progress = state.progress[question.id] ?? emptyProgress();
  progress.lastSeenIndex = ++state.appMeta.questionIndex;
  state.progress[question.id] = progress;
  state.appMeta.recentQuestions = [...state.appMeta.recentQuestions.slice(-19), question];
}

export function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0')).join('-');
}

function addResult(counts: Counts, result: boolean | 'skip'): void {
  if (result === 'skip') {
    counts.skipped++;
    return;
  }
  counts.attempts++;
  if (result) counts.correct++;
  else counts.wrong++;
}

export function recordResult(
  state: State, question: Question, result: boolean | 'skip', now = new Date(), random = Math.random,
): void {
  const { id } = question;
  const progress = state.progress[id] ??= emptyProgress();
  const daily = state.dailyStats[localDate(now)] ??= { ...emptyCounts(), byKana: {} };
  const dailyKana = daily.byKana[id] ??= emptyCounts();
  [progress, daily, dailyKana].forEach((counts) => addResult(counts, result));
  if (result === 'skip') return;

  const previousReview = state.reviewQueue[id];
  progress.recentResults = [...progress.recentResults.slice(-9), result];
  progress.streak = result ? progress.streak + 1 : 0;
  progress.lastAnsweredAt = now.toISOString();
  state.appMeta.answeredCount++;
  state.appMeta.streak = result ? state.appMeta.streak + 1 : 0;
  if (result) {
    delete state.reviewQueue[id];
  } else {
    state.reviewQueue[id] = {
      dueAfter: state.appMeta.answeredCount + 3 + Math.floor(random() * 5),
      createdAt: state.appMeta.answeredCount,
      consecutiveReviewFailures: question.review ? (previousReview?.consecutiveReviewFailures ?? 0) + 1 : 0,
    };
  }
}

export function totals(records: Iterable<Counts>): Counts {
  const result = emptyCounts();
  for (const counts of records) {
    result.attempts += counts.attempts;
    result.correct += counts.correct;
    result.wrong += counts.wrong;
    result.skipped += counts.skipped;
  }
  return result;
}

export function resetProgress(state: State, ids?: ReadonlySet<string>): void {
  if (!ids) {
    state.progress = {};
    state.dailyStats = {};
    state.reviewQueue = {};
    state.appMeta = initialState().appMeta;
    return;
  }

  for (const id of ids) {
    delete state.progress[id];
    delete state.reviewQueue[id];
  }
  for (const [date, stats] of Object.entries(state.dailyStats)) {
    for (const id of ids) delete stats.byKana[id];
    if (Object.keys(stats.byKana).length) Object.assign(stats, totals(Object.values(stats.byKana)));
    else delete state.dailyStats[date];
  }
  state.appMeta.recentQuestions = state.appMeta.recentQuestions.filter(({ id }) => !ids.has(id));
  state.appMeta.streak = 0;
}
