import { categories, normalizeAnswer, type Category, type Kana } from '../catalog/catalog.ts';

interface AnswerPair {
  hiragana?: string;
  katakana?: string;
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
    const pair = pairs.get(key) ?? { reading: kana };
    pair[kana.script] = kana.kana;
    pairs.set(key, pair);
  }

  const sections = categories.map((category) => {
    const section = document.createElement('section');
    section.className = 'answer-section';
    const title = document.createElement('h2');
    title.id = `answer-category-${category}`;
    title.textContent = labels[category];
    const grid = document.createElement('ul');
    grid.className = 'answer-grid';
    grid.setAttribute('role', 'list');
    grid.setAttribute('aria-labelledby', title.id);

    const entries = [...pairs.values()].filter(({ reading }) => reading.category === category)
      .map(({ hiragana, katakana, reading }) => {
        const card = document.createElement('li');
        card.className = 'answer-card';
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
        grid.append(card);
        return {
          card,
          glyphCount: glyphs.childElementCount,
          terms: [hiragana ?? '', katakana ?? '', ...reading.acceptedKo, ...reading.acceptedRomaji].map(normalizeAnswer),
        };
      });

    section.append(title, grid);
    grids.append(section);
    return { section, entries };
  });

  function updateResults(): void {
    const query = normalizeAnswer(search.value);
    let total = 0;
    for (const { section, entries } of sections) {
      let visible = 0;
      for (const { card, glyphCount, terms } of entries) {
        card.hidden = !terms.some((term) => term.includes(query));
        if (!card.hidden) visible += glyphCount;
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
