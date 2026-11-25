// Vercel build step: writes public/config.js from environment variables so the
// Supabase keys live in Vercel's env settings (or a local .env), never in git.
const fs = require('fs');
const path = require('path');

// Local convenience: load a .env file if present (Vercel injects env vars directly).
try {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env, that's fine on Vercel */ }

const URL = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_ANON_KEY || '';
if (!URL || !KEY) {
  console.warn('WARNING: SUPABASE_URL / SUPABASE_ANON_KEY are not set. The deployed app will show the "not configured" screen until you add them in Vercel → Settings → Environment Variables.');
}

const outDir = 'public';
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync('index.html', path.join(outDir, 'index.html'));
fs.writeFileSync(
  path.join(outDir, 'config.js'),
  'window.RZ_CONFIG = ' + JSON.stringify({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: KEY }) + ';\n'
);
console.log('Built public/ (config.js written; url set:', !!URL, '| key set:', !!KEY, ')');
