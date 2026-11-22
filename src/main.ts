import csv from '../kana-loop-catalog-v1.0.csv?raw';
import { parseCatalog } from './catalog/catalog.ts';
import { startApp } from './ui/app.ts';
import './ui/style.css';

startApp(parseCatalog(csv));

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  let controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const next = navigator.serviceWorker.controller;
    if (controller && next && next !== controller) {
      document.getElementById('app-update')!.hidden = false;
    }
    controller = next;
  });
  document.getElementById('reload-app')!.addEventListener('click', () => location.reload());
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' }).catch((error) => {
      console.warn('Kana Loop offline cache is unavailable', error);
    });
  });
}
