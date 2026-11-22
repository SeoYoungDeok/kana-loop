import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = 'dist';
const template = await readFile(new URL('./worker.js', import.meta.url), 'utf8');

async function list(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? list(path) : path;
  }))).flat();
}

const files = (await list(root)).filter((path) => path !== join(root, 'sw.js')).sort();
const hash = createHash('sha256').update(template);
for (const file of files) hash.update(file).update(await readFile(file));
const paths = files.map((path) => `./${relative(root, path).replaceAll('\\', '/')}`);
const worker = template
  .replace('/* CACHE_VERSION */ ""', JSON.stringify(hash.digest('hex').slice(0, 16)))
  .replace('/* PRECACHE */ []', JSON.stringify(paths));
await writeFile(join(root, 'sw.js'), worker);
