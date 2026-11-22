import csv from '../kana-loop-catalog-v1.0.csv?raw';
import { parseCatalog } from './catalog/catalog.ts';
import { startApp } from './ui/app.ts';
import './ui/style.css';

startApp(parseCatalog(csv));

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
      console.warn('Kana Loop offline cache is unavailable', error);
    });
  });
}
