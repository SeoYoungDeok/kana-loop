import { categories, normalizeAnswer, vowels, type Category, type Kana } from '../catalog/catalog.ts';

interface AnswerPair {
  hiragana?: string;
  katakana?: string;
  row: string;
  reading: Kana;
}

function renderReading(language: 'ko' | 'romaji', primary: string, accepted: readonly string[]): HTMLElement {
  const reading = document.createElement('span');
  reading.className = 'answer-reading';
  reading.dataset.reading = language;
  const representative = document.createElement('strong');
  representative.textContent = primary;
  reading.append(representative);

  const alternatives = accepted.filter((answer) => answer !== primary);
  if (alternatives.length) {
    const variants = document.createElement('span');
    variants.className = 'reading-variants';
    variants.textContent = alternatives.join(', ');
    reading.append(' ', variants);
  }
  return reading;
}

function renderCard({ hiragana, katakana, reading }: AnswerPair) {
  const card = document.createElement('li');
  card.className = 'answer-card';
  card.style.gridColumnStart = String(reading.dan === 'none' ? 1 : vowels.indexOf(reading.dan) + 1);
  const glyphs = document.createElement('div');
  glyphs.className = 'answer-glyphs';
  for (const glyph of [hiragana, katakana].filter((glyph) => glyph !== undefined)) {
    const character = document.createElement('span');
    character.lang = 'ja';
    character.textContent = glyph;
    glyphs.append(character);
  }
  const readings = document.createElement('div');
  readings.className = 'answer-readings';
  readings.append(
    renderReading('ko', reading.primaryKo, reading.acceptedKo),
    renderReading('romaji', reading.primaryRomaji, reading.acceptedRomaji),
  );
  card.append(glyphs, readings);
  return {
    card,
    glyphCount: glyphs.childElementCount,
    terms: [hiragana ?? '', katakana ?? '', ...reading.acceptedKo, ...reading.acceptedRomaji].map(normalizeAnswer),
  };
}

export function mountAnswerKey(catalog: readonly Kana[], labels: Record<Category, string>): void {
  const search = document.querySelector<HTMLInputElement>('#answer-search')!;
  const count = document.getElementById('answer-count')!;
  const empty = document.getElementById('answer-empty')!;
  const grids = document.getElementById('answer-grids')!;
  const pairs = new Map<string, AnswerPair>();

  for (const kana of catalog) {
    // Corresponding katakana and hiragana differ by 0x60 in the kana block.
    const hiragana = kana.kana.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
    const key = JSON.stringify([kana.category, hiragana, kana.primaryKo, kana.acceptedKo, kana.primaryRomaji, kana.acceptedRomaji]);
    // Contracted sounds with the same row code can have different leading kana.
    const row = kana.category === 'contracted' ? hiragana[0] : kana.gyou;
    const pair = pairs.get(key) ?? { reading: kana, row };
    pair[kana.script] = kana.kana;
    pairs.set(key, pair);
  }

  const sections = categories.map((category) => {
    const section = document.createElement('section');
    section.className = 'answer-section';
    const title = document.createElement('h2');
    title.id = `answer-category-${category}`;
    title.textContent = labels[category];
    section.setAttribute('aria-labelledby', title.id);
    section.append(title);

    const rowGroups = new Map<string, AnswerPair[]>();
    for (const pair of pairs.values()) {
      if (pair.reading.category !== category) continue;
      const group = rowGroups.get(pair.row);
      if (group) group.push(pair);
      else rowGroups.set(pair.row, [pair]);
    }

    const rows = [...rowGroups.values()].map((group) => {
      const list = document.createElement('ul');
      list.className = 'answer-row';
      list.setAttribute('role', 'list');
      const entries = group.map(renderCard);
      list.append(...entries.map(({ card }) => card));
      section.append(list);
      return { list, entries };
    });
    grids.append(section);
    return { section, rows };
  });

  function updateResults(): void {
    const query = normalizeAnswer(search.value);
    let total = 0;
    for (const { section, rows } of sections) {
      let visible = 0;
      for (const { list, entries } of rows) {
        let rowCount = 0;
        for (const { card, glyphCount, terms } of entries) {
          card.hidden = !terms.some((term) => term.includes(query));
          if (!card.hidden) rowCount += glyphCount;
        }
        list.hidden = rowCount === 0;
        visible += rowCount;
      }
      section.hidden = visible === 0;
      total += visible;
    }
    count.textContent = `${total}자`;
    empty.hidden = total > 0;
  }

  search.addEventListener('input', updateResults);
  updateResults();
}
