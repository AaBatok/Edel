import fs from 'fs';
import path from 'path';
import readline from 'readline';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Ensure a directory exists (creates recursively if needed)
 * @param {string} dir - Directory path to ensure
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure session directory exists
 */
function ensureSessionDir() {
  ensureDir(config.sessionDir);
}

/**
 * Save browser storage state (cookies, localStorage, etc.) to disk
 * @param {import('playwright').BrowserContext} context - Playwright browser context
 */
export async function saveSession(context) {
  ensureSessionDir();
  const state = await context.storageState();
  fs.writeFileSync(config.sessionFile, JSON.stringify(state, null, 2), 'utf-8');
  logger.info(`💾 Session saved to ${config.sessionFile}`);
  return state;
}

/**
 * Save raw session state object to disk
 * @param {object} state - Storage state object
 * @param {string} [sessionFile] - Optional path to save to (defaults to config.sessionFile)
 */
export function saveSessionRaw(state, sessionFile) {
  const target = sessionFile || config.sessionFile;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(state, null, 2), 'utf-8');
  logger.info(`💾 Session saved to ${target}`);
}

/**
 * Load saved session state from disk
 * @param {string} [sessionFile] - Optional path to load from (defaults to config.sessionFile)
 * @returns {object|null} Storage state object or null if not found
 */
export function loadSession(sessionFile) {
  const target = sessionFile || config.sessionFile;
  if (!fs.existsSync(target)) {
    logger.warn(`⚠️  No saved session found at ${target}`);
    return null;
  }

  try {
    const data = fs.readFileSync(target, 'utf-8');
    const state = JSON.parse(data);
    logger.debug(`📂 Session loaded from ${target}`);
    return state;
  } catch (err) {
    logger.error(`Failed to load session from ${target}: ${err.message}`);
    return null;
  }
}

/**
 * Check if a saved session exists
 */
export function hasSession() {
  return fs.existsSync(config.sessionFile);
}

/**
 * Delete saved session
 */
export function clearSession() {
  if (fs.existsSync(config.sessionFile)) {
    fs.unlinkSync(config.sessionFile);
    logger.info('🗑️  Session cleared.');
  }
}

/**
 * Get session age in hours
 */
export function getSessionAge() {
  if (!fs.existsSync(config.sessionFile)) return null;
  const stats = fs.statSync(config.sessionFile);
  const ageMs = Date.now() - stats.mtimeMs;
  return ageMs / (1000 * 60 * 60);
}

/**
 * Check if session might be expired (older than 48 hours)
 */
export function isSessionLikelyExpired() {
  const age = getSessionAge();
  if (age === null) return true;
  return age > 48;
}

// ─────────────────────────────────────────────
//  Helper: ask a question in terminal
// ─────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─────────────────────────────────────────────
//  Parse raw "Cookie:" header string into array
//  Input:  "name1=value1; name2=value2; ..."
//  Output: [{name, value, domain, path, ...}]
// ─────────────────────────────────────────────
function parseCookieString(cookieStr, domain = 'runway.edel.finance') {
  const cookies = [];
  // Remove "Cookie: " prefix if present
  const cleaned = cookieStr.replace(/^Cookie:\s*/i, '').trim();
  const pairs = cleaned.split(/;\s*/);

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.substring(0, eqIdx).trim();
    const value = pair.substring(eqIdx + 1).trim();
    if (!name) continue;

    cookies.push({
      name,
      value,
      domain,
      path: '/',
      expires: Date.now() / 1000 + 86400 * 30, // 30 days
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

// ─────────────────────────────────────────────
//  Build Playwright-compatible state from input
// ─────────────────────────────────────────────
function buildState(cookies) {
  return {
    cookies,
    origins: [
      {
        origin: 'https://runway.edel.finance',
        localStorage: [],
      },
    ],
  };
}

// ─────────────────────────────────────────────
//  IMPORT: Main function
// ─────────────────────────────────────────────
export async function importSession(sessionFile) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         🔐 IMPORT SESSION LOGIN                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Cara ambil Cookie dari Chrome:');
  console.log('');
  console.log('  1. Buka Chrome → login ke https://runway.edel.finance');
  console.log('  2. Setelah masuk, buka halaman /listing-calls');
  console.log('  3. Tekan F12 (DevTools) → klik tab "Network"');
  console.log('  4. Refresh halaman (Ctrl+R)');
  console.log('  5. Klik request pertama di daftar');
  console.log('  6. Di panel kanan, cari "Request Headers"');
  console.log('  7. Cari baris "Cookie:"');
  console.log('  8. Klik kanan pada value → Copy value');
  console.log('  9. Paste di bawah ini (SEMUA, panjang gapapa)');
  console.log('');
  console.log('  Yang penting ada: edel_session=eyJ...');
  console.log('');

  const input = await ask('📋 Paste Cookie > ');

  if (!input) {
    logger.error('❌ Tidak ada data.');
    return false;
  }

  // Detect what format the user pasted
  let cookies = [];

  if (input.includes('=') && (input.includes(';') || input.startsWith('edel_session='))) {
    // User pasted full cookie string or just edel_session=xxx
    cookies = parseCookieString(input);
  } else if (input.startsWith('eyJ')) {
    // User pasted just the JWT token value (starts with eyJ = base64 {"v"...)
    logger.info('🔍 Detected raw JWT token, wrapping as edel_session cookie...');
    cookies = [
      {
        name: 'edel_session',
        value: input,
        domain: 'runway.edel.finance',
        path: '/',
        expires: Date.now() / 1000 + 86400 * 30,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      },
    ];
  } else {
    // Try parsing as cookie string anyway
    cookies = parseCookieString(input);
  }

  if (cookies.length === 0) {
    logger.error('❌ Gagal parse cookies.');
    logger.info('   Format yang benar: name1=value1; name2=value2; ...');
    logger.info('   Atau paste langsung token yang dimulai dengan eyJ...');
    return false;
  }

  // Check if edel_session is present
  const hasEdel = cookies.some((c) => c.name === 'edel_session');
  if (!hasEdel) {
    logger.warn('⚠️  Cookie "edel_session" tidak ditemukan!');
    logger.warn('   Pastikan kamu sudah LOGIN dulu sebelum copy cookie.');
    logger.warn('   Cookies yang ditemukan:');
    cookies.forEach((c) => logger.warn(`     - ${c.name}`));

    const proceed = await ask('Lanjutkan tanpa edel_session? [y/N] > ');
    if (proceed.toLowerCase() !== 'y') {
      logger.info('Dibatalkan. Login dulu, lalu coba lagi.');
      return false;
    }
  }

  // Save
  const state = buildState(cookies);
  saveSessionRaw(state, sessionFile);

  console.log('');
  logger.info('✅ Session berhasil di-import!');
  logger.info(`   🍪 ${cookies.length} cookies saved`);
  if (hasEdel) {
    logger.info('   🔑 edel_session ✓ (JWT token found)');
  }
  console.log('');
  logger.info('Sekarang jalankan:');
  logger.info('   npm run vote    → test vote sekali');
  logger.info('   npm run start   → mulai bot scheduler');
  return true;
}

// ─────────────────────────────────────────────
//  IMPORT: From JSON file
// ─────────────────────────────────────────────
export function importSessionFromFile(filePath, sessionFile) {
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    logger.error(`❌ File tidak ditemukan: ${absPath}`);
    return false;
  }

  try {
    const data = fs.readFileSync(absPath, 'utf-8');
    const state = JSON.parse(data);

    if (!state.cookies || !state.origins) {
      logger.error('❌ Format file tidak valid. Harus punya "cookies" dan "origins".');
      return false;
    }

    saveSessionRaw(state, sessionFile);

    const cookieCount = state.cookies.length;
    const lsCount = state.origins[0]?.localStorage?.length || 0;

    logger.info('✅ Session berhasil di-import dari file!');
    logger.info(`   🍪 ${cookieCount} cookies, 📦 ${lsCount} localStorage items`);
    return true;
  } catch (err) {
    logger.error(`❌ Gagal import: ${err.message}`);
    return false;
  }
}
