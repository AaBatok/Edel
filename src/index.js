import { validateConfig } from './utils/config.js';
import config from './utils/config.js';
import logger, { logSeparator } from './utils/logger.js';
import { hasSession, getSessionAge, clearSession, importSession, importSessionFromFile } from './auth/session.js';
import { checkSession } from './api/client.js';
import { startScheduler, runSingleVote } from './scheduler/cron.js';

// Get CLI command
const command = process.argv[2] || 'help';
const extraArg = process.argv[3] || null;

/**
 * Print usage help
 */
function printHelp() {
  console.log(`
\x1b[36m
  ▄▄▄▄▄▄▄                               ▄▄                     ██   ▄▄▄   ▄▄▄  ▄▄▄▄▄▄▄   ▄▄▄▄   
  ███▀▀███▄        ██         ▄▄        ██                     ██   ███   ███ ███▀▀▀▀▀ ▄██▀▀██▄ 
  ███▄▄███▀  ▀▀█▄ ▀██▀▀ ▄███▄ ██ ▄█▀ ▄████ ████▄ ▄████ ████▄   ██   █████████ ███      ███  ███ 
  ███  ███▄ ▄█▀██  ██   ██ ██ ████   ██ ██ ██ ▀▀ ██ ██ ██ ██   ██   ███▀▀▀███ ███      ███▀▀███ 
  ████████▀ ▀█▄██  ██   ▀███▀ ██ ▀█▄ ▀████ ██    ▀████ ██ ██   ██   ███   ███ ▀███████ ███  ███ 
                                                    ██         ██                               
                                                  ▀▀▀                                           \x1b[0m
\x1b[90m  ──────────────────────────────────────────────────────────────────────────────────\x1b[0m
\x1b[33m   ⚡ Edel Runway Desk — Auto Vote Bot v2.0\x1b[0m
\x1b[90m   🌐 Pure HTTP Mode — No Browser Needed\x1b[0m
\x1b[90m  ──────────────────────────────────────────────────────────────────────────────────\x1b[0m

Usage: node src/index.js <command>

Commands:
  import    ⭐ Import session dari Chrome DevTools
            Login di Chrome PC → F12 → Network → copy Cookie → paste.

  import-file <path>
            Import session dari file JSON.

  vote      Vote sekali saja (tanpa scheduling)

  start     Mulai bot scheduler (default: setiap 1 jam)
            Bot berjalan terus sampai dihentikan (Ctrl+C)

  status    Cek status session dan konfigurasi

  clear     Hapus session (force re-import)

  help      Tampilkan bantuan ini

NPM Shortcuts:
  npm run import    → import session dari Chrome
  npm run vote      → vote sekali
  npm run start     → mulai bot scheduler

Workflow:
  1. Login di Chrome PC → F12 → Network → copy Cookie
  2. Di VPS: npm run import → paste cookie
  3. Di VPS: npm run vote (test)
  4. Di VPS: npm run start (jalankan bot)

💡 Bot ini TIDAK butuh Chrome/browser di VPS!
   Semua dilakukan via HTTP request langsung.
`);
}

/**
 * Show current bot status
 */
async function showStatus() {
  logSeparator();
  logger.info('📊 Bot Status');
  logSeparator();

  // Session status
  if (hasSession()) {
    const age = getSessionAge();
    const ageStr = age !== null ? `${age.toFixed(1)} jam` : 'unknown';

    // Test if session is actually valid
    logger.info('🔍 Testing session...');
    const valid = await checkSession();

    if (valid) {
      logger.info(`✅ Session: Valid (umur: ${ageStr})`);
    } else {
      logger.warn(`⚠️  Session: Expired/Invalid (umur: ${ageStr})`);
      logger.info('   Jalankan "npm run import" untuk import ulang.');
    }
  } else {
    logger.error('❌ Session: Belum ada');
    logger.info('   Jalankan "npm run import" untuk import dari Chrome.');
  }

  // Config
  logger.info('');
  logger.info('⚙️  Configuration:');
  logger.info(`   Strategy:    ${config.voteStrategy}`);
  logger.info(`   Schedule:    ${config.cronSchedule}`);
  logger.info(`   Max Retries: ${config.maxRetries}`);
  logger.info(`   Base URL:    ${config.baseUrl}`);
  logger.info(`   Telegram:    ${config.telegramBotToken ? 'Configured ✅' : 'Not set ⚠️'}`);
  logger.info(`   Mode:        Pure HTTP (no browser)`);
  logSeparator();
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Validate config (except for help command)
    if (command !== 'help') {
      validateConfig();
    }

    switch (command) {
      case 'import':
        await importSession();
        break;

      case 'import-file':
        if (!extraArg) {
          logger.error('❌ Perlu path ke file JSON.');
          logger.info('   Contoh: node src/index.js import-file ./session.json');
        } else {
          importSessionFromFile(extraArg);
        }
        break;

      case 'vote':
        await runSingleVote();
        break;

      case 'start':
        await startScheduler();
        break;

      case 'status':
        await showStatus();
        break;

      case 'clear':
        clearSession();
        logger.info('Session dihapus. Jalankan "npm run import" untuk import ulang.');
        break;

      case 'help':
      default:
        printHelp();
        break;
    }
  } catch (err) {
    logger.error(`Fatal error: ${err.message}`);
    logger.debug(err.stack);
    process.exit(1);
  }
}

main();
