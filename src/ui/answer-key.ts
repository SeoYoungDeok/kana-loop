import { categories, normalizeAnswer, type Category, type Kana } from '../catalog/catalog.ts';

interface AnswerPair {
  hiragana?: string;
  katakana?: string;
  reading: Kana;
}

function appendReading(cell: HTMLTableCellElement, primary: string, accepted: readonly string[]): void {
  const representative = document.createElement('strong');
  representative.textContent = primary;
  cell.append(representative);

  const alternatives = accepted.filter((answer) => answer !== primary);
  if (alternatives.length) {
    const variants = document.createElement('span');
    variants.className = 'reading-variants';
    variants.textContent = alternatives.join(', ');
    cell.append(' ', variants);
  }
}

export function mountAnswerKey(catalog: readonly Kana[], labels: Record<Category, string>): void {
  const search = document.querySelector<HTMLInputElement>('#answer-search')!;
  const count = document.getElementById('answer-count')!;
  const empty = document.getElementById('answer-empty')!;
  const tables = document.getElementById('answer-tables')!;
  const pairs = new Map<string, AnswerPair>();

  for (const kana of catalog) {
    // Corresponding katakana and hiragana differ by 0x60 in the kana block.
    const hiragana = kana.kana.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
    const key = JSON.stringify([kana.category, hiragana, kana.primaryKo, kana.acceptedKo, kana.primaryRomaji, kana.acceptedRomaji]);
    const pair = pairs.get(key) ?? { reading: kana };
    pair[kana.script] = kana.kana;
    pairs.set(key, pair);
  }

  const headings = ['히라가나', '가타카나', '한글', '로마자'];
  const sections = categories.map((category) => {
    const section = document.createElement('section');
    section.className = 'section-card answer-section';
    const title = document.createElement('h2');
    title.id = `answer-category-${category}`;
    title.textContent = labels[category];
    const table = document.createElement('table');
    table.className = 'answer-table';
    table.setAttribute('aria-labelledby', title.id);
    const header = table.createTHead().insertRow();
    for (const label of headings) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      header.append(cell);
    }

    const body = table.createTBody();
    const entries = [...pairs.values()].filter(({ reading }) => reading.category === category)
      .map(({ hiragana, katakana, reading }) => {
        const row = body.insertRow();
        for (const glyph of [hiragana, katakana]) {
          const cell = row.insertCell();
          cell.className = 'answer-glyph';
          if (glyph) cell.lang = 'ja';
          cell.textContent = glyph ?? '—';
        }
        appendReading(row.insertCell(), reading.primaryKo, reading.acceptedKo);
        appendReading(row.insertCell(), reading.primaryRomaji, reading.acceptedRomaji);
        return {
          row,
          glyphCount: Number(Boolean(hiragana)) + Number(Boolean(katakana)),
          terms: [hiragana ?? '', katakana ?? '', ...reading.acceptedKo, ...reading.acceptedRomaji].map(normalizeAnswer),
        };
      });

    section.append(title, table);
    tables.append(section);
    return { section, entries };
  });

  function updateResults(): void {
    const query = normalizeAnswer(search.value);
    let total = 0;
    for (const { section, entries } of sections) {
      let visible = 0;
      for (const { row, glyphCount, terms } of entries) {
        row.hidden = !terms.some((term) => term.includes(query));
        if (!row.hidden) visible += glyphCount;
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
