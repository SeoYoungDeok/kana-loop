import {
  allFilters, categories, judge, rows, scripts, vowels, type Filters, type Kana,
} from '../catalog/catalog.ts';
import {
  initialState, localDate, mastery, pickQuestion, questionPool, recordResult,
  resetProgress, showQuestion, totals, weakness, type Counts, type Question, type Settings, type State,
} from '../engine/engine.ts';
import { createBackup, parseBackup } from '../storage/backup.ts';
import { claimWriter, loadState, openDatabase, saveState, StaleStateError } from '../storage/database.ts';
import { mountAnswerKey } from './answer-key.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const button = (id: string) => el<HTMLButtonElement>(id);
const showingAnswers = () => location.hash === '#answers';
const scriptLabel = { hiragana: '히라가나', katakana: '가타카나' };
const categoryLabel = { basic: '청음', voiced: '탁음', semi: '반탁음', contracted: '요음' };
const rowLabels = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', 'ん'];
const groups = [
  { key: 'script', title: '문자 체계', values: scripts, labels: Object.values(scriptLabel) },
  { key: 'category', title: '음 종류', values: categories, labels: Object.values(categoryLabel) },
  { key: 'gyou', title: '행', values: rows, labels: rowLabels },
  { key: 'dan', title: '단', values: vowels, labels: ['あ', 'い', 'う', 'え', 'お'] },
] as const;

type Page = Settings['lastPage'];
type Feedback = { kind: 'correct' } | { kind: 'wrong'; kana: Kana; answer: string } | null;

function accuracy(counts?: Pick<Counts, 'attempts' | 'correct'>): string {
  return counts?.attempts ? `${Math.round(100 * counts.correct / counts.attempts)}%` : '—';
}

function mountFilterControls(): void {
  for (const { key, title, values, labels } of groups) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    const choices = document.createElement('div');
    legend.textContent = title;
    choices.className = 'choices';
    values.forEach((value, i) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      const text = document.createElement('span');
      input.type = 'checkbox';
      input.name = key;
      input.value = value;
      text.textContent = labels[i];
      if (key === 'gyou' || key === 'dan') text.lang = 'ja';
      label.append(input, text);
      choices.append(label);
    });
    fieldset.append(legend, choices);
    el('filter-groups').append(fieldset);
  }
}

export async function startApp(catalog: Kana[]): Promise<void> {
  const ids = new Set(catalog.map(({ id }) => id));
  const byId = new Map(catalog.map((kana) => [kana.id, kana]));
  const answer = el<HTMLInputElement>('answer');
  const feedbackBox = el('feedback');
  const confirmation = el<HTMLDialogElement>('confirmation');
  const fileInput = el<HTMLInputElement>('backup-file');
  const main = document.querySelector('main')!;
  let state = initialState();
  let revision = 0;
  let db: IDBDatabase;
  let page: Page = 'quiz';
  let question: Question | null = null;
  let busy = true;
  let writable = false;
  let referenceOnly = showingAnswers();
  let releaseWriter: (() => void) | undefined;
  let errorAction: (() => Promise<void>) | null = null;
  let failed = false;
  let composing = false;
  let editingAnswer = false;
  let justComposed = false;
  let submitAfterComposition = false;
  let compositionTimer = 0;
  let feedback: Feedback = null;
  let undo: { state: State; question: Question; answer: string } | null = null;
  let statScope: 'all' | 'current' = 'all';
  let storageSupported = false;
  let persistent = false;
  let pendingConfirmation: (() => Promise<void>) | null = null;

  mountFilterControls();
  mountAnswerKey(catalog, categoryLabel);

  function status(message: string): void {
    const box = el('global-status');
    box.textContent = message;
    box.hidden = !message;
  }

  function focusAnswer(): void {
    if (page === 'quiz' && !showingAnswers() && writable && !failed && !confirmation.open) {
      if (question) answer.focus();
      else el('empty-message').focus();
    }
  }

  function addQuestion(target: State): Question | null {
    const next = pickQuestion(questionPool(catalog, target), target);
    if (next) showQuestion(target, next);
    return next;
  }

  async function commit(next: State): Promise<void> {
    revision = await saveState(db, state, next, revision);
    state = next;
  }

  function renderStats(pool: readonly Kana[]): void {
    const today = state.dailyStats[localDate(new Date())];
    const all = totals(Object.values(state.progress));
    const current = totals(pool.flatMap(({ id }) => state.progress[id] ? [state.progress[id]] : []));
    const summary = [
      ['오늘 시도', `${today?.attempts ?? 0}회`],
      ['오늘 정답률', accuracy(today)],
      ['누적 시도', `${all.attempts}회`],
      ['현재 범위 정답률', accuracy(current)],
      ['연속 정답', `${state.appMeta.streak}회`],
    ];
    el('stat-summary').replaceChildren(...summary.map(([label, value]) => {
      const item = document.createElement('div');
      const caption = document.createElement('span');
      const number = document.createElement('strong');
      caption.textContent = label;
      number.textContent = value;
      item.append(caption, number);
      return item;
    }));

    const items = statScope === 'all' ? catalog : pool;
    const ranked = items.filter(({ id }) => weakness(state.progress[id]) > 0)
      .sort((a, b) => weakness(state.progress[b.id]) - weakness(state.progress[a.id]));
    const rank = new Map(ranked.map(({ id }, i) => [id, i + 1]));
    const body = el('stat-rows');
    const tableRows = [...ranked, ...items.filter(({ id }) => !rank.has(id))].map(({ id, kana }) => {
      const progress = state.progress[id];
      const recent = progress?.recentResults ?? [];
      const row = document.createElement('tr');
      const values = [
        kana, String(progress?.attempts ?? 0), accuracy(progress),
        accuracy({ attempts: recent.length, correct: recent.filter(Boolean).length }),
        mastery(progress), rank.has(id) ? String(rank.get(id)) : '—',
      ];
      values.forEach((value, i) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (i === 0) cell.lang = 'ja';
      });
      return row;
    });
    if (!tableRows.length) {
      const row = document.createElement('tr');
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.textContent = '현재 범위에 해당하는 문항이 없습니다.';
      tableRows.push(row);
    }
    body.replaceChildren(...tableRows);
  }

  function render(): void {
    const visiblePage = showingAnswers() ? 'answers' : page;
    const pool = questionPool(catalog, state);
    const today = state.dailyStats[localDate(new Date())];
    const blocked = busy || failed || !writable;
    main.setAttribute('aria-busy', String(busy));
    el('today-count').textContent = `${today?.attempts ?? 0}문항`;
    el('today-accuracy').textContent = accuracy(today);
    el('streak').textContent = String(state.appMeta.streak);
    for (const section of ['quiz', 'settings', 'stats', 'answers']) el(section).hidden = visiblePage !== section;
    if (visiblePage === 'answers') el('answers-link').setAttribute('aria-current', 'page');
    else el('answers-link').removeAttribute('aria-current');
    for (const control of document.querySelectorAll<HTMLElement>('[data-page]')) {
      if (control.dataset.page === visiblePage) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }

    el('quiz-content').hidden = !question;
    el('quiz-empty').hidden = Boolean(question);
    button('open-settings').hidden = busy || !writable;
    el('empty-message').textContent = !writable
      ? (busy ? '학습 기록을 불러오는 중입니다.' : '이 탭은 기록을 조회할 수 있습니다.')
      : pool.length ? '문제를 불러오는 중입니다.' : '현재 학습 범위에 해당하는 문항이 없습니다.';
    if (question) {
      const kana = byId.get(question.id)!;
      el('question-kana').textContent = kana.kana;
      el('question-category').textContent = `${scriptLabel[kana.script]} · ${categoryLabel[kana.category]}${question.review ? ' · 복습' : ''}`;
      el('question-pool').textContent = `${pool.length}문항 범위`;
    }
    answer.readOnly = blocked;
    button('submit-answer').disabled = blocked || !question;
    if (feedback) {
      const { kind } = feedback;
      const line = document.createElement('p');
      const title = document.createElement('strong');
      title.textContent = kind === 'correct' ? '정답' : '오답';
      line.append(title);
      feedbackBox.replaceChildren(line);
      if (kind === 'wrong') {
        const { kana, answer: submitted } = feedback;
        const previousKana = document.createElement('span');
        previousKana.lang = 'ja';
        previousKana.textContent = kana.kana;
        line.append(' · ', previousKana, ` 정답 ${kana.primaryKo} / ${kana.primaryRomaji}`);
        const details = document.createElement('p');
        const alternatives = [...kana.acceptedKo.filter((item) => item !== kana.primaryKo),
          ...kana.acceptedRomaji.filter((item) => item !== kana.primaryRomaji)];
        details.className = 'details';
        details.textContent = `내 답안 ${submitted}${alternatives.length ? ` · 허용 표기 ${alternatives.join(', ')}` : ''}`;
        feedbackBox.append(details);
      }
      feedbackBox.dataset.kind = kind;
    } else {
      feedbackBox.replaceChildren();
      delete feedbackBox.dataset.kind;
    }

    if (visiblePage === 'settings') {
      for (const input of document.querySelectorAll<HTMLInputElement>('#filter-groups input')) {
        const values: readonly string[] = state.settings.filters[input.name as typeof groups[number]['key']];
        input.checked = values.includes(input.value);
        input.disabled = blocked;
      }
      for (const preset of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
        preset.disabled = blocked;
        if (preset.dataset.preset === 'weak') preset.setAttribute('aria-pressed', String(state.settings.filters.weakOnly));
      }
      button('start-quiz').disabled = blocked || !pool.length;
      el('settings-count').textContent = `${pool.length}문항`;
      el('filter-warning').hidden = pool.length > 0;
      const { filters } = state.settings;
      el('filter-warning').textContent = !filters.script.length || !filters.category.length
        ? '문자 체계와 음 종류를 각각 하나 이상 선택해 주세요.'
        : filters.weakOnly ? '선택한 범위에 취약 문자가 없습니다.' : '선택한 행과 단 조합에 해당하는 문항이 없습니다.';
      button('export-backup').disabled = busy || failed;
      button('import-backup').disabled = blocked;
      button('reset-scope').disabled = blocked || !pool.length;
      button('reset-all').disabled = blocked;
      button('persist-storage').hidden = !storageSupported || persistent || !writable;
      button('persist-storage').disabled = blocked;
      el('storage-status').textContent = persistent ? '브라우저 저장 유지 허용됨' : '이 브라우저에 저장';
    }

    if (visiblePage === 'stats') renderStats(pool);
  }

  async function run(action: () => Promise<void>, refocus = false): Promise<void> {
    if (busy) return;
    busy = true;
    failed = false;
    el('error-panel').hidden = true;
    // Keep the focused control in place during a write. Every action also checks busy.
    main.setAttribute('aria-busy', 'true');
    answer.readOnly = true;
    try {
      await action();
      errorAction = null;
    } catch (error) {
      errorAction = error instanceof StaleStateError ? null : () => run(action, refocus);
      failed = true;
      el('error-message').textContent = error instanceof StaleStateError
        ? error.message : '브라우저에 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.';
      el('error-panel').hidden = false;
      button('retry').textContent = errorAction ? '다시 시도' : '새로고침';
    } finally {
      busy = false;
      render();
      if (refocus) focusAnswer();
    }
  }

  function setQuestion(next: Question | null): void {
    question = next;
    editingAnswer = false;
    feedback = null;
    answer.value = '';
  }

  function navigate(nextPage: Page): void {
    if (busy) return;
    if (showingAnswers()) {
      history.replaceState(history.state, '', location.pathname + location.search);
      render();
    }
    if (referenceOnly) {
      void run(async () => {
        db?.close();
        await initialize(nextPage);
        referenceOnly = false;
        if (nextPage !== 'quiz') {
          render();
          el(`${nextPage}-title`).focus();
        }
      }, nextPage === 'quiz');
      return;
    }
    const needsQuestion = nextPage === 'quiz' && writable && !question && questionPool(catalog, state).length > 0;
    if (failed || (nextPage === page && !needsQuestion)) {
      focusAnswer();
      return;
    }
    status(writable ? '' : '다른 탭에서 학습 중입니다. 이 탭에서 학습하려면 다른 탭을 닫고 새로고침해 주세요.');
    if (!writable) {
      page = nextPage;
      render();
      if (page !== 'quiz') el(`${page}-title`).focus();
      return;
    }
    void run(async () => {
      const next = structuredClone(state);
      next.settings.lastPage = nextPage;
      const newQuestion = nextPage === 'quiz' && !question ? addQuestion(next) : null;
      await commit(next);
      page = nextPage;
      undo = null;
      if (newQuestion) setQuestion(newQuestion);
      if (page !== 'quiz') {
        render();
        el(`${page}-title`).focus();
      }
    }, nextPage === 'quiz');
  }

  function respond(skip = false): void {
    if (page !== 'quiz' || busy || failed || !writable || !question || composing || justComposed) return;
    const displayed = question;
    const kana = byId.get(displayed.id)!;
    const input = answer.value;
    const result = skip ? 'skip' : judge(kana, input);
    if (result === null) return;
    const now = new Date();
    const previous = structuredClone(state);
    const next = structuredClone(state);
    recordResult(next, displayed, result, now);
    const upcoming = addQuestion(next);
    void run(async () => {
      await commit(next);
      setQuestion(upcoming);
      undo = result === 'skip' ? null : { state: previous, question: displayed, answer: input };
      if (result === true) feedback = { kind: 'correct' };
      if (result === false) feedback = { kind: 'wrong', kana, answer: input };
    }, true);
  }

  function undoAnswer(): void {
    const last = undo;
    if (!last) return;
    void run(async () => {
      await commit(last.state);
      setQuestion(last.question);
      answer.value = last.answer;
      undo = null;
    }, true);
  }

  function updateFilters(filters: Filters): void {
    if (!writable || busy || failed) {
      render();
      return;
    }
    void run(async () => {
      const next = structuredClone(state);
      next.settings.filters = filters;
      await commit(next);
      setQuestion(null);
      undo = null;
    });
  }

  function downloadBackup(snapshot: State, exportedAt: string): void {
    const blob = new Blob([createBackup(snapshot, exportedAt)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kana-loop-${localDate(new Date(exportedAt))}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportBackup(): void {
    if (busy || failed) return;
    const exportedAt = new Date().toISOString();
    const snapshot = structuredClone(state);
    if (writable) snapshot.appMeta.lastBackupAt = exportedAt;
    downloadBackup(snapshot, exportedAt);
    if (writable) void run(() => commit(snapshot));
  }

  function confirmAction(title: string, message: string, label: string, action: () => Promise<void>, backup = false): void {
    el('dialog-title').textContent = title;
    el('dialog-message').textContent = message;
    button('dialog-confirm').textContent = label;
    button('dialog-backup').hidden = !backup;
    pendingConfirmation = action;
    confirmation.returnValue = '';
    confirmation.showModal();
  }

  function requestReset(scope: 'all' | 'current'): void {
    if (busy || failed || !writable) return;
    const idsToReset = new Set(questionPool(catalog, state).map(({ id }) => id));
    const description = scope === 'all' ? '전체 학습 기록' : `현재 출제 범위 ${idsToReset.size}문항의 학습 기록`;
    confirmAction('학습 기록 초기화', `${description}을 지웁니다. 출제 범위 설정은 유지됩니다.`, '초기화', async () => {
      const next = structuredClone(state);
      resetProgress(next, scope === 'current' ? idsToReset : undefined);
      await commit(next);
      setQuestion(null);
      undo = null;
      status('학습 기록을 초기화했습니다.');
    });
  }

  for (const control of document.querySelectorAll<HTMLElement>('[data-page]')) {
    control.addEventListener('click', (event) => {
      event.preventDefault();
      navigate(control.dataset.page as Page);
    });
  }
  window.addEventListener('hashchange', () => {
    render();
    if (showingAnswers()) el('answers-title').focus();
    else if (page === 'quiz' || referenceOnly) navigate(page);
    else el(`${page}-title`).focus();
  });
  el('answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    respond();
  });
  answer.addEventListener('compositionstart', () => {
    composing = true;
    justComposed = false;
    submitAfterComposition = false;
    clearTimeout(compositionTimer);
  });
  answer.addEventListener('compositionend', () => {
    composing = false;
    justComposed = true;
    // Wait for the browser to write the committed text into the input.
    compositionTimer = window.setTimeout(() => {
      justComposed = false;
      const submit = submitAfterComposition;
      submitAfterComposition = false;
      if (submit && document.activeElement === answer && !showingAnswers()) respond();
    }, 0);
  });
  answer.addEventListener('blur', () => { submitAfterComposition = false; });
  answer.addEventListener('input', () => {
    editingAnswer = true;
    if (feedback) {
      feedback = null;
      feedbackBox.replaceChildren();
      delete feedbackBox.dataset.kind;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (page !== 'quiz' || showingAnswers() || confirmation.open || event.defaultPrevented) return;
    const target = event.target;
    const enter = event.key === 'Enter';
    if (event.isComposing || event.keyCode === 229 || composing || justComposed) {
      if (target === answer && (composing || justComposed) && !event.repeat) {
        submitAfterComposition = enter || event.code === 'Enter' || event.code === 'NumpadEnter';
        // Let the IME finish its own composition, but suppress a subsequent form submit.
        if (submitAfterComposition && !composing && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
        }
      }
      return;
    }
    const quizTarget = target === answer || target === document.body
      || target === button('submit-answer') || target === el('empty-message');
    if (!quizTarget) return;
    if (question && (enter || event.key === 'Escape')) {
      event.preventDefault();
      if (!event.repeat) respond(event.key === 'Escape');
    } else if (undo && !busy && !failed && (event.ctrlKey || event.metaKey) && !event.shiftKey
      && !event.altKey && event.key.toLowerCase() === 'z' && !editingAnswer) {
      event.preventDefault();
      if (!event.repeat) undoAnswer();
    }
  });

  el('filter-groups').addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const selected = (key: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${key}"]:checked`)]
      .map((input) => input.value);
    const filters: Filters = {
      script: scripts.filter((value) => selected('script').includes(value)),
      category: categories.filter((value) => selected('category').includes(value)),
      gyou: rows.filter((value) => selected('gyou').includes(value)),
      dan: vowels.filter((value) => selected('dan').includes(value)),
      weakOnly: state.settings.filters.weakOnly,
    };
    updateFilters(filters);
  });
  for (const preset of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    preset.addEventListener('click', () => {
      const filters = allFilters();
      switch (preset.dataset.preset) {
        case 'basic':
          filters.script = [...state.settings.filters.script];
          filters.category = ['basic'];
          break;
        case 'hiragana': filters.script = ['hiragana']; break;
        case 'katakana': filters.script = ['katakana']; break;
        case 'weak':
          updateFilters({ ...state.settings.filters, weakOnly: !state.settings.filters.weakOnly });
          return;
        case 'clear':
          updateFilters({ script: [], category: [], gyou: [], dan: [], weakOnly: false });
          return;
      }
      updateFilters(filters);
    });
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-stat-scope]')) {
    control.addEventListener('click', () => {
      statScope = control.dataset.statScope === 'current' ? 'current' : 'all';
      for (const item of document.querySelectorAll('[data-stat-scope]')) {
        item.setAttribute('aria-pressed', String(item === control));
      }
      renderStats(questionPool(catalog, state));
    });
  }

  button('retry').addEventListener('click', () => {
    if (errorAction) void errorAction();
    else location.reload();
  });
  button('export-backup').addEventListener('click', exportBackup);
  button('dialog-backup').addEventListener('click', () => downloadBackup(state, new Date().toISOString()));
  button('import-backup').addEventListener('click', () => { if (!busy && writable) fileInput.click(); });
  button('reset-scope').addEventListener('click', () => requestReset('current'));
  button('reset-all').addEventListener('click', () => requestReset('all'));
  button('persist-storage').addEventListener('click', async () => {
    try {
      persistent = await navigator.storage.persist();
      status(persistent ? '브라우저가 저장 유지를 허용했습니다.' : '브라우저가 저장 유지 요청을 허용하지 않았습니다.');
    } catch {
      status('저장 유지 상태를 확인할 수 없습니다.');
    }
    render();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || busy || failed || !writable) return;
    try {
      const imported = parseBackup(await file.text(), ids);
      const counts = totals(Object.values(imported.progress));
      confirmAction('백업 복원', `시도 ${counts.attempts}회, 기록 날짜 ${Object.keys(imported.dailyStats).length}일, 복습 예약 ${Object.keys(imported.reviewQueue).length}개를 복원합니다. 현재 기록과 설정을 교체합니다.`,
        '복원', async () => {
          await commit(imported);
          setQuestion(null);
          undo = null;
          status('백업에서 학습 기록과 설정을 복원했습니다.');
        }, true);
    } catch (error) {
      status(error instanceof Error ? error.message : '백업 파일을 읽을 수 없습니다.');
    }
  });
  confirmation.addEventListener('close', () => {
    const action = pendingConfirmation;
    pendingConfirmation = null;
    if (confirmation.returnValue === 'confirm' && action && !failed && !busy) void run(action);
  });

  async function initialize(requestedPage?: Page): Promise<void> {
    const writer = referenceOnly && !requestedPage ? null : await claimWriter();
    try {
      db = await openDatabase();
      ({ state, revision } = await loadState(db));
      writable = writer?.writable ?? false;
      page = requestedPage ?? state.settings.lastPage;
      if (writer && !writable) {
        status('다른 탭에서 학습 중입니다. 이 탭에서 학습하려면 다른 탭을 닫고 새로고침해 주세요.');
        page = requestedPage ?? 'stats';
      } else if (writable && (page === 'quiz' || page !== state.settings.lastPage)) {
        const next = structuredClone(state);
        next.settings.lastPage = page;
        const starting = page === 'quiz' && !showingAnswers() ? addQuestion(next) : null;
        if (starting || page !== state.settings.lastPage) await commit(next);
        setQuestion(starting);
      }
      storageSupported = typeof navigator.storage?.persist === 'function';
      if (navigator.storage?.persisted) persistent = await navigator.storage.persisted().catch(() => false);
      releaseWriter = writer?.release;
    } catch (error) {
      writer?.release();
      db?.close();
      writable = false;
      throw error;
    }
  }

  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) {
      db?.close();
      releaseWriter?.();
    }
  });

  busy = false;
  await run(initialize, true);
  if (showingAnswers()) el('answers-title').focus();
}
