export const scripts = ['hiragana', 'katakana'] as const;
export const categories = ['basic', 'voiced', 'semi', 'contracted'] as const;
export const rows = ['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa', 'n'] as const;
export const vowels = ['a', 'i', 'u', 'e', 'o'] as const;

export type Script = typeof scripts[number];
export type Category = typeof categories[number];
export type Row = typeof rows[number];
export type Vowel = typeof vowels[number];

export interface Kana {
  id: string;
  script: Script;
  kana: string;
  category: Category;
  gyou: Row;
  dan: Vowel | 'none';
  primaryKo: string;
  acceptedKo: string[];
  primaryRomaji: string;
  acceptedRomaji: string[];
  note: string;
}

export interface Filters {
  script: Script[];
  category: Category[];
  gyou: Row[];
  dan: Vowel[];
  weakOnly: boolean;
}

export function allFilters(): Filters {
  return { script: [...scripts], category: [...categories], gyou: [...rows], dan: [...vowels], weakOnly: false };
}

export function parseCatalog(csv: string): Kana[] {
  // Handle quoted commas and doubled quotes as well as the bundled CSV's BOM.
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const contents = csv.replace(/^\uFEFF/, '').trimEnd();
  for (let i = 0; i < contents.length; i++) {
    const char = contents[i];
    if (char === '"') {
      if (quoted && contents[i + 1] === '"') {
        field += char;
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ',') {
      record.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (char === '\r' && contents[i + 1] === '\n') i++;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Unclosed CSV field');
  records.push([...record, field]);

  const header = 'id,script,kana,category,gyou,dan,primary_ko,accepted_ko,primary_romaji,accepted_romaji,note';
  if (records.shift()?.join(',') !== header) throw new Error('Invalid catalog header');

  return records.map((fields) => {
    const [id, script, kana, category, gyou, dan, primaryKo, ko, primaryRomaji, romaji, note] = fields;
    if (fields.length !== 11 || !contains(scripts, script) || !contains(categories, category)
      || !contains(rows, gyou) || (dan !== 'none' && !contains(vowels, dan))
      || id !== `${script[0]}:${kana}` || !primaryKo || !primaryRomaji) {
      throw new Error(`Invalid catalog row: ${id}`);
    }
    const acceptedKo = ko.split('|');
    const acceptedRomaji = romaji.split('|');
    if (!acceptedKo.includes(primaryKo) || !acceptedRomaji.includes(primaryRomaji)) {
      throw new Error(`Missing primary answer: ${id}`);
    }
    return { id, script, kana, category, gyou, dan, primaryKo, acceptedKo, primaryRomaji, acceptedRomaji, note };
  });
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function filterCatalog(catalog: readonly Kana[], filters: Filters, isWeak: (id: string) => boolean): Kana[] {
  const nasalOnly = filters.gyou.length === 1 && filters.gyou[0] === 'n';
  const allVowels = vowels.every((vowel) => filters.dan.includes(vowel));
  return catalog.filter(({ id, script, category, gyou, dan }) =>
    filters.script.includes(script) && filters.category.includes(category) && filters.gyou.includes(gyou)
    && (dan === 'none' ? nasalOnly || allVowels : filters.dan.includes(dan))
    && (!filters.weakOnly || isWeak(id)));
}

export function normalizeAnswer(answer: string): string {
  return answer.trim().normalize('NFC').replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function judge(kana: Kana, answer: string): boolean | null {
  const normalized = normalizeAnswer(answer);
  if (!normalized) return null;
  return kana.acceptedKo.includes(normalized) || kana.acceptedRomaji.includes(normalized);
}
