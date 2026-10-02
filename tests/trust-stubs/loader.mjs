// Module hooks for tests/trust.test.js: the real public/js modules, with the
// browser-only ones they import (API client, store, IndexedDB key store, DOM
// helpers, uploads) swapped for the in-memory stand-ins in this folder.
const here = new URL('./', import.meta.url).href;
const publicJs = new URL('../../public/js/', import.meta.url).href;
const STUBS = {
  'api.js': 'api.js',
  'store.js': 'store.js',
  'dom.js': 'dom.js',
  'uploads.js': 'uploads.js',
  'securemedia.js': 'securemedia.js',
  'crypto/keystore.js': 'keystore.js',
};

export async function resolve(spec, ctx, next) {
  if (ctx.parentURL && ctx.parentURL.startsWith(publicJs) && spec.startsWith('.')) {
    const target = new URL(spec, ctx.parentURL).href;
    if (target.startsWith(publicJs)) {
      const rel = target.slice(publicJs.length);
      if (STUBS[rel]) return { url: here + STUBS[rel], shortCircuit: true };
    }
  }
  return next(spec, ctx);
}
