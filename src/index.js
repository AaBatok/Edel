import { validateConfig } from './utils/config.js';
import config from './utils/config.js';
import logger, { logSeparator } from './utils/logger.js';
import { hasSession, getSessionAge, clearSession, importSession, importSessionFromFile } from './auth/session.js';
import { checkSession } from './api/client.js';
import { startScheduler, runSingleVote } from './scheduler/cron.js';
import {
  getAccounts, getEnabledAccounts, addAccount, removeAccount,
  enableAccount, disableAccount, initDefaultAccount, getAccount,
  updateAccountSession,
} from './accounts/manager.js';

import readline from 'readline';

// Get CLI command
const command = process.argv[2] || 'help';
const extraArg = process.argv[3] || null;
const extraArg2 = process.argv[4] || null;

/**
 * Ask a question in terminal
 */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Parse cookie input into array of cookie objects
 */
function parseCookieInput(input) {
  if (!input || input.length < 10) return null;

  const domain = 'runway.edel.finance';
  const makeCookie = (name, value) => ({
    name, value, domain, path: '/',
    expires: Date.now() / 1000 + 86400 * 30,
    httpOnly: false, secure: true, sameSite: 'Lax',
  });

  // Full cookie string: "edel_session=eyJ...;other=val"
  if (input.includes('=') && (input.includes(';') || input.startsWith('edel_session='))) {
    const cleaned = input.replace(/^Cookie:\s*/i, '').trim();
    const pairs = cleaned.split(/;\s*/);
    const cookies = [];
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (name) cookies.push(makeCookie(name, value));
    }
    return cookies.length > 0 ? cookies : null;
  }

  // Raw JWT: "eyJhbGci..."
  if (input.startsWith('eyJ') && input.length > 50) {
    return [makeCookie('edel_session', input)];
  }

  return null;
}

/**
 * Interactive import wizard — bulk setup for multiple accounts
 */
async function importWizard() {
  console.log('');
  console.log('\x1b[96m\x1b[1m  ╔══════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[96m\x1b[1m  ║       🔐 IMPORT SESSION — MULTI ACCOUNT          ║\x1b[0m');
  console.log('\x1b[96m\x1b[1m  ╚══════════════════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log('  Cara ambil Cookie dari Chrome:');
  console.log('  1. Buka Chrome → login https://runway.edel.finance');
  console.log('  2. Tekan F12 → Network → Refresh halaman');
  console.log('  3. Klik request pertama → cari header Cookie');
  console.log('  4. Copy value cookie-nya');
  console.log('');

  // Check existing accounts
  const existing = getAccounts();
  if (existing.length > 0) {
    console.log(`  📋 Akun yang sudah ada: ${existing.map(a => a.id).join(', ')}`);
    console.log('');
  }

  // Ask how many accounts
  const countStr = await ask('  Mau setup berapa akun? > ');
  const count = parseInt(countStr, 10);

  if (isNaN(count) || count < 1) {
    console.log('\x1b[31m  ❌ Jumlah tidak valid.\x1b[0m');
    return;
  }

  if (count > config.maxAccounts) {
    console.log(`\x1b[31m  ❌ Maksimal ${config.maxAccounts} akun.\x1b[0m`);
    return;
  }

  console.log('');
  console.log(`  📝 Setup ${count} akun (A1 - A${count})`);
  console.log('  💡 Paste cookie untuk setiap akun. Ketik "skip" untuk lewati.');
  console.log('');

  let imported = 0;
  let skipped = 0;

  for (let i = 1; i <= count; i++) {
    const accountId = `A${i}`;

    // Create account if doesn't exist
    let account = getAccount(accountId);
    if (!account) {
      try {
        account = addAccount(accountId);
      } catch (e) {
        account = getAccount(accountId);
      }
    }

    console.log(`\x1b[96m  ── ${accountId} ──────────────────────────────\x1b[0m`);

    const input = await ask(`  🍪 [${accountId}] Paste cookie > `);

    if (!input || input.toLowerCase() === 'skip') {
      console.log(`  ⏭️  ${accountId} dilewati.`);
      skipped++;
      console.log('');
      continue;
    }

    const cookies = parseCookieInput(input);
    if (!cookies) {
      console.log(`\x1b[33m  ⚠️  ${accountId}: Gagal parse cookie. Skip.\x1b[0m`);
      skipped++;
      console.log('');
      continue;
    }

    // Save cookie to account session
    updateAccountSession(accountId, cookies);
    imported++;

    const hasEdel = cookies.some(c => c.name === 'edel_session');
    console.log(`  ✅ ${accountId}: ${cookies.length} cookies saved ${hasEdel ? '(edel_session ✓)' : ''}`);
    console.log('');
  }

  // Summary
  console.log('\x1b[35m  ════════════════════════════════════════════════\x1b[0m');
  console.log(`  📊 Hasil: ${imported} imported, ${skipped} skipped`);
  console.log('');

  if (imported > 0) {
    console.log('  ✅ Sekarang jalankan:');
    console.log('     \x1b[92mnpm run start\x1b[0m   → mulai bot auto-vote');
    console.log('');
    console.log('  💡 Update cookie via Telegram (saat bot running):');
    console.log('     Kirim: \x1b[93mA2 eyJhbGci...\x1b[0m');
  }

  if (skipped > 0) {
    console.log(`  ℹ️  ${skipped} akun belum ada cookie.`);
    console.log('     Import via Telegram nanti: \x1b[93mA3 eyJhbGci...\x1b[0m');
  }

  console.log('');
}

/**
 * Print usage help
 */
function printHelp() {
  console.log(`
\x1b[96m\x1b[1m  EDEL BOT \x1b[0m\x1b[90m─\x1b[0m\x1b[37m AUTO VOTE (Multi-Account)\x1b[0m
\x1b[90m  Created by Batokdrgn | HCA\x1b[0m
\x1b[35m  ════════════════════════════════════════════════\x1b[0m

Usage: node src/index.js <command>

Setup:
  import         🔐 Import session multi-akun (interactive wizard)
                 Tanya jumlah akun → paste cookie satu-satu.

Bot Commands:
  start          Mulai bot scheduler (auto vote semua akun)
  vote           Vote sekali untuk semua akun enabled
  status         Cek status semua akun
  list           List semua akun
  help           Tampilkan bantuan ini

Account Management:
  add [id]       Tambah akun (e.g. add A5)
  remove <id>    Hapus akun (e.g. remove A5)
  enable <id>    Enable akun
  disable <id>   Disable akun
  clear [id]     Hapus session akun

NPM Shortcuts:
  npm run import  → setup akun (interactive wizard)
  npm run start   → mulai bot scheduler
  npm run vote    → vote sekali

Telegram Cookie Import (saat bot running):
  Kirim di Telegram: A1 eyJhbGci...
  Bot akan auto-update session dan retry vote.

💡 Bot ini TIDAK butuh Chrome/browser di VPS!
`);
}

/**
 * List all accounts
 */
function listAccounts() {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    logger.info('📋 Belum ada akun. Jalankan: node src/index.js add A1');
    return;
  }

  logSeparator();
  logger.info(`📋 Daftar Akun (${accounts.length})`);
  logSeparator();

  for (const acc of accounts) {
    const enabled = acc.enabled ? '✅' : '⛔';
    const status = acc.lastVoteStatus || 'never';
    const lastVote = acc.lastVote
      ? new Date(acc.lastVote).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : 'never';
    logger.info(`  ${enabled} ${acc.id} | Last: ${lastVote} | Status: ${status}`);
  }
  logSeparator();
}

/**
 * Show current bot status (multi-account)
 */
async function showStatus() {
  initDefaultAccount();
  const accounts = getAccounts();

  logSeparator();
  logger.info('📊 Bot Status');
  logSeparator();

  if (accounts.length === 0) {
    logger.info('📋 Belum ada akun.');
  } else {
    for (const acc of accounts) {
      const enabled = acc.enabled ? '✅' : '⛔';
      const sessionExists = acc.sessionFile ? true : false;
      let sessionStatus = 'No session';

      if (sessionExists) {
        try {
          const valid = await checkSession(acc.sessionFile);
          sessionStatus = valid ? 'Valid ✅' : 'Expired ⚠️';
        } catch {
          sessionStatus = 'Error';
        }
      }

      const lastVote = acc.lastVote
        ? new Date(acc.lastVote).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
        : 'never';

      logger.info(`  ${enabled} ${acc.id} | Session: ${sessionStatus} | Last vote: ${lastVote}`);
    }
  }

  logger.info('');
  logger.info('⚙️  Configuration:');
  logger.info(`   Strategy:     ${config.voteStrategy}`);
  logger.info(`   Interval:     ${config.voteIntervalMinutes}m + ${config.voteBufferMinutes}m buffer`);
  logger.info(`   Max Retries:  ${config.maxRetries}`);
  logger.info(`   Acct Delay:   ${config.delayBetweenAccounts / 1000}s`);
  logger.info(`   Telegram:     ${config.telegramBotToken ? 'Configured ✅' : 'Not set ⚠️'}`);
  logger.info(`   Mode:         Pure HTTP (no browser)`);
  logSeparator();
}

/**
 * Main entry point
 */
async function main() {
  try {
    if (command !== 'help') {
      validateConfig();
    }

    switch (command) {
      case 'import': {
        initDefaultAccount();
        await importWizard();
        break;
      }

      case 'import-file': {
        const accountId = extraArg || 'A1';
        const filePath = extraArg2 || extraArg;
        if (!filePath) {
          logger.error('❌ Perlu: node src/index.js import-file <id> <path>');
          break;
        }
        initDefaultAccount();
        let account = getAccount(accountId.toUpperCase());
        if (!account) account = addAccount(accountId.toUpperCase());
        importSessionFromFile(filePath, account.sessionFile);
        break;
      }

      case 'list':
        initDefaultAccount();
        listAccounts();
        break;

      case 'add': {
        const id = extraArg ? extraArg.toUpperCase() : undefined;
        const account = addAccount(id);
        logger.info(`✅ Akun ${account.id} ditambahkan!`);
        logger.info(`   Session: ${account.sessionFile}`);
        logger.info(`   Import: node src/index.js import ${account.id}`);
        break;
      }

      case 'remove':
        if (!extraArg) {
          logger.error('❌ Perlu ID akun. Contoh: node src/index.js remove A3');
          break;
        }
        removeAccount(extraArg.toUpperCase());
        logger.info(`🗑️  Akun ${extraArg.toUpperCase()} dihapus.`);
        break;

      case 'enable':
        if (!extraArg) {
          logger.error('❌ Perlu ID akun.');
          break;
        }
        enableAccount(extraArg.toUpperCase());
        logger.info(`✅ Akun ${extraArg.toUpperCase()} enabled.`);
        break;

      case 'disable':
        if (!extraArg) {
          logger.error('❌ Perlu ID akun.');
          break;
        }
        disableAccount(extraArg.toUpperCase());
        logger.info(`⛔ Akun ${extraArg.toUpperCase()} disabled.`);
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

      case 'clear': {
        const acctId = extraArg ? extraArg.toUpperCase() : 'A1';
        const acct = getAccount(acctId);
        if (acct && acct.sessionFile) {
          const path = await import('path');
          const fs = await import('fs');
          const absPath = path.default.resolve(config.rootDir, acct.sessionFile);
          if (fs.default.existsSync(absPath)) {
            fs.default.unlinkSync(absPath);
            logger.info(`🗑️  Session ${acctId} dihapus.`);
          }
        } else {
          clearSession();
        }
        break;
      }

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
