import config from '../utils/config.js';
import logger, { logSeparator } from '../utils/logger.js';
import { performVote } from '../bot/voter.js';
// Cookie listener is built-in (startCookieListener)
import { initDisplay, setAccounts, updateAccountStatus, destroyDisplay } from '../utils/display.js';
import { getEnabledAccounts, getAccounts, updateAccountStatus as updateAccountDb, initDefaultAccount } from '../accounts/manager.js';
import {
  notifyVoteSuccess,
  notifyVoteFailed,
  notifySessionExpired,
  notifyBotStarted,
  notifyNextVote,
  notifyAlreadyVoted,
  notifyVoteSummary,
  sendTelegram,
} from '../utils/telegram.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track session-expired notifications per account to avoid spam
const sessionExpiredNotified = new Set();

// Track active timer for graceful shutdown
let nextVoteTimer = null;

/**
 * Determine next delay (in ms) based on vote cycle result.
 */
function getNextDelay(result) {
  switch (result) {
    case 'voted':
    case 'already_voted':
      return (config.voteIntervalMinutes + config.voteBufferMinutes) * 60 * 1000;
    case 'waiting':
    case 'failed':
    default:
      return config.retryIntervalMinutes * 60 * 1000;
  }
}

/**
 * Vote for a single account.
 * Returns: { accountId, status, details }
 */
async function voteForAccount(account) {
  const accountId = account.id;
  const sessionFile = account.sessionFile;

  logger.info(`[${accountId}] 🔄 Starting vote...`);
  updateAccountStatus(accountId, { status: 'running' });

  try {
    const result = await performVote({ id: accountId, sessionFile });

    if (result.success) {
      // Determine status type
      if (result.details?.note?.includes('Already submitted')) {
        await notifyAlreadyVoted(result.details.note, accountId);
        return { accountId, status: 'already_voted', details: result.details };
      } else if (result.details?.note) {
        await notifyAlreadyVoted(result.details.note, accountId);
        return { accountId, status: 'waiting', details: result.details };
      } else {
        await notifyVoteSuccess(result.details, accountId);
        return { accountId, status: 'voted', details: result.details };
      }
    }

    // Check if session expired → try Telegram re-import
    if (result.details?.sessionExpired) {
      logger.error(`[${accountId}] 🔑 Session expired.`);

      if (!sessionExpiredNotified.has(accountId)) {
        sessionExpiredNotified.add(accountId);
        await notifySessionExpired(accountId);
      }

      updateAccountStatus(accountId, { status: 'expired' });
      return { accountId, status: 'expired', details: result.details };
    }

    // Don't notify here — let the retry loop in voteCycle handle final notification
    return { accountId, status: 'failed', details: result.details };

  } catch (err) {
    logger.error(`[${accountId}] 💥 Crashed: ${err.message}`);
    // Don't notify here — let the retry loop in voteCycle handle final notification
    return { accountId, status: 'failed', details: { error: err.message } };
  }
}

/**
 * Execute a vote cycle for ALL enabled accounts (sequentially).
 * Returns the "worst" status for scheduling decisions.
 */
async function voteCycle() {
  logSeparator();
  logger.info(`⏰ Vote cycle started at ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);

  const accounts = getEnabledAccounts();
  if (accounts.length === 0) {
    logger.warn('⚠️  No enabled accounts. Add accounts first.');
    return 'failed';
  }

  logger.info(`👥 Voting for ${accounts.length} account(s)...`);

  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    // Skip accounts that already voted and don't need retry yet
    if (account.nextVote && account.lastVoteStatus) {
      const nextVoteTime = new Date(account.nextVote);
      const now = new Date();
      const alreadyDone = ['voted', 'already_voted'].includes(account.lastVoteStatus);
      if (alreadyDone && nextVoteTime > now) {
        logger.info(`[${account.id}] ⏭️ Skip — already voted, next at ${nextVoteTime.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
        results.push({ accountId: account.id, status: account.lastVoteStatus, details: { note: 'skipped' } });
        continue;
      }
    }

    // Retry logic per account
    let lastResult = null;
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      if (attempt > 1) {
        logger.info(`[${account.id}] 🔄 Retry ${attempt}/${config.maxRetries}...`);
        await sleep(config.retryDelay * attempt);
      }

      lastResult = await voteForAccount(account);

      // Don't retry if voted, already_voted, waiting, or session expired
      if (['voted', 'already_voted', 'waiting', 'expired'].includes(lastResult.status)) {
        break;
      }

      // Only retry on 'failed'
      if (attempt >= config.maxRetries) {
        logger.error(`[${account.id}] ❌ All ${config.maxRetries} attempts failed.`);
        // Send ONE failure notification after all retries exhausted
        await notifyVoteFailed({
          ...lastResult.details,
          attempt: config.maxRetries,
          maxAttempts: config.maxRetries,
          willRetry: false,
        }, account.id);
      }
    }

    results.push(lastResult);

    // Update DB
    const now = new Date();
    const nextDelay = getNextDelay(lastResult.status);
    const nextVoteTime = new Date(now.getTime() + nextDelay);

    updateAccountDb(account.id, {
      lastVote: now.toISOString(),
      lastVoteStatus: lastResult.status,
      nextVote: nextVoteTime.toISOString(),
    });

    // Update TUI
    updateAccountStatus(account.id, {
      status: lastResult.status,
      nextVote: nextVoteTime,
    });

    // Delay between accounts (avoid rate limiting)
    if (i < accounts.length - 1) {
      const delaySec = config.delayBetweenAccounts / 1000;
      logger.info(`⏳ Waiting ${delaySec}s before next account...`);
      await sleep(config.delayBetweenAccounts);
    }
  }

  // Send summary if multiple accounts
  if (results.length > 1) {
    await notifyVoteSummary(results.map(r => ({
      accountId: r.accountId,
      status: r.status,
      asset: r.details?.asset,
      error: r.details?.error,
    })));
  }

  // Handle session-expired accounts: wait for Telegram cookie
  const expiredAccounts = results.filter(r => r.status === 'expired');
  if (expiredAccounts.length > 0) {
    logger.info(`🔑 ${expiredAccounts.length} account(s) with expired session. Waiting for cookie via Telegram...`);
    // Don't block — the cookie import listener runs in the background
  }

  // Schedule next cycle based on EARLIEST nextVote among all accounts.
  // If A1 failed (retry 5min) but A2-A7 succeeded (60min), schedule at 5min
  // so A1 gets retried. Accounts that already succeeded will just skip.
  if (results.some(r => r.status === 'failed')) return 'failed';
  if (results.some(r => r.status === 'waiting')) return 'waiting';
  if (results.some(r => r.status === 'already_voted')) return 'already_voted';
  if (results.some(r => r.status === 'voted')) return 'voted';
  return 'failed';
}

/**
 * Schedule the next vote cycle.
 */
function scheduleNextVote(delayMs) {
  if (nextVoteTimer) {
    clearTimeout(nextVoteTimer);
    nextVoteTimer = null;
  }

  const nextTime = new Date(Date.now() + delayMs);
  const nextStr = nextTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const delayMin = Math.round(delayMs / 60000);

  logger.info(`⏰ Next vote cycle: ${nextStr} (in ${delayMin} minutes)`);

  nextVoteTimer = setTimeout(async () => {
    try {
      const result = await voteCycle();
      const nextDelay = getNextDelay(result);
      scheduleNextVote(nextDelay);
    } catch (err) {
      logger.error(`Scheduled vote cycle error: ${err.message}`);
      const retryDelay = config.retryIntervalMinutes * 60 * 1000;
      scheduleNextVote(retryDelay);
    }
  }, delayMs);

  return nextTime;
}

/**
 * Start the dynamic vote scheduler (multi-account).
 */
export async function startScheduler() {
  const totalMin = config.voteIntervalMinutes + config.voteBufferMinutes;

  // Migrate legacy single-account if needed
  initDefaultAccount();

  const accounts = getEnabledAccounts();
  const allAccounts = getAccounts();

  // Initialize TUI
  initDisplay({ strategy: config.voteStrategy, interval: String(totalMin) });
  setAccounts(allAccounts);

  logger.info(`👥 Accounts : ${accounts.length} enabled / ${allAccounts.length} total`);
  logger.info(`📅 Interval : ${config.voteIntervalMinutes}m + ${config.voteBufferMinutes}m buffer = ${totalMin}m`);
  logger.info(`🔄 Retry    : every ${config.retryIntervalMinutes}m`);
  logger.info(`🎯 Strategy : ${config.voteStrategy}`);
  logger.info(`⏱️  Delay    : ${config.delayBetweenAccounts / 1000}s between accounts`);
  logger.info(`📨 Telegram : ${config.telegramBotToken ? 'Configured ✅' : 'Not configured ⚠️'}`);
  logger.info('');

  // Send Telegram notification
  await notifyBotStarted(accounts.length);

  // Start cookie listener in background (handles all accounts)
  startCookieListener();

  logger.info('▶️  Running initial vote cycle...');
  const result = await voteCycle();

  // Schedule next vote
  const nextDelay = getNextDelay(result);
  scheduleNextVote(nextDelay);

  logger.info('');
  logger.info('📡 Bot is running with dynamic scheduling...');

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('');
    logger.info('🛑 Bot stopping...');
    destroyDisplay();
    if (nextVoteTimer) {
      clearTimeout(nextVoteTimer);
      nextVoteTimer = null;
    }
    const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    await sendTelegram(`🛑 *BOT STOPPED*\n\n🕐 Waktu: ${time}`);
    logger.info('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Background cookie listener for multi-account.
 * Parses format: "A1 eyJhbGci..." or "A1 edel_session=eyJ..."
 * Auto-retries vote for the account after cookie import.
 */
function startCookieListener() {
  const { telegramBotToken, telegramChatId } = config;
  if (!telegramBotToken || !telegramChatId) return;

  const TELEGRAM_API = 'https://api.telegram.org/bot';
  let offset = 0;
  let initialized = false;

  async function poll() {
    try {
      // Skip old messages on first poll
      if (!initialized) {
        initialized = true;
        try {
          const initUrl = `${TELEGRAM_API}${telegramBotToken}/getUpdates?offset=-1&limit=1`;
          const initRes = await fetch(initUrl);
          const initData = await initRes.json();
          if (initData.ok && initData.result.length > 0) {
            offset = initData.result[initData.result.length - 1].update_id + 1;
          }
        } catch (e) {
          // ignore
        }
      }

      const url = `${TELEGRAM_API}${telegramBotToken}/getUpdates?offset=${offset}&timeout=30`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.ok) {
        setTimeout(poll, 5000);
        return;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(telegramChatId)) continue;

        const text = msg.text.trim();

        // Parse multi-account format: "A1 eyJ..." or "A3 edel_session=eyJ..."
        const match = text.match(/^(A\d+)\s+(.+)$/i);
        if (!match) continue;

        const accountId = match[1].toUpperCase();
        const cookieData = match[2].trim();

        // Parse the cookie
        const cookies = parseCookieInput(cookieData);
        if (!cookies) continue;

        // Use account manager (already imported at top)
        const { updateAccountSession, getAccount } = await import('../accounts/manager.js');
        const account = getAccount(accountId);

        if (!account) {
          await sendTelegram(`❌ Akun *${accountId}* tidak ditemukan. Cek /list.`);
          continue;
        }

        updateAccountSession(accountId, cookies);
        sessionExpiredNotified.delete(accountId);

        logger.info(`🍪 [${accountId}] Cookie diterima via Telegram!`);

        await sendTelegram([
          `✅ *SESSION UPDATED* [${accountId}]`,
          '',
          `🍪 ${cookies.length} cookies imported`,
          '',
          '▶️ Auto-retrying vote...',
        ].join('\n'));

        // Delete cookie message for security
        try {
          await fetch(`${TELEGRAM_API}${telegramBotToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: telegramChatId, message_id: msg.message_id }),
          });
        } catch (e) {
          // ignore
        }

        // Auto-retry vote for this account
        try {
          const result = await voteForAccount(account);
          const nextDelay = getNextDelay(result.status);
          const nextVoteTime = new Date(Date.now() + nextDelay);

          updateAccountDb(accountId, {
            lastVote: new Date().toISOString(),
            lastVoteStatus: result.status,
            nextVote: nextVoteTime.toISOString(),
          });

          updateAccountStatus(accountId, {
            status: result.status,
            nextVote: nextVoteTime,
          });
        } catch (err) {
          logger.error(`[${accountId}] Auto-retry failed: ${err.message}`);
        }
      }
    } catch (err) {
      // ignore polling errors
    }

    // Continue polling
    setTimeout(poll, 1000);
  }

  // Start polling
  poll();
}

/**
 * Parse cookie input string (from Telegram message).
 */
function parseCookieInput(input) {
  if (!input || input.length < 20) return null;

  // Cookie string: "edel_session=eyJ...;other=val"
  if (input.includes('edel_session=')) {
    const cleaned = input.replace(/^Cookie:\s*/i, '').trim();
    const pairs = cleaned.split(/;\s*/);
    const cookies = [];
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (!name) continue;
      cookies.push({
        name, value,
        domain: 'runway.edel.finance',
        path: '/',
        expires: Date.now() / 1000 + 86400 * 30,
        httpOnly: false, secure: true, sameSite: 'Lax',
      });
    }
    return cookies.length > 0 ? cookies : null;
  }

  // Raw JWT: "eyJhbGci..."
  if (input.startsWith('eyJ') && input.length > 50 && !input.includes(' ')) {
    return [{
      name: 'edel_session',
      value: input,
      domain: 'runway.edel.finance',
      path: '/',
      expires: Date.now() / 1000 + 86400 * 30,
      httpOnly: false, secure: true, sameSite: 'Lax',
    }];
  }

  return null;
}

/**
 * Run a single vote for all accounts (no scheduling)
 */
export async function runSingleVote() {
  initDefaultAccount();
  logSeparator();
  logger.info('🗳️  Running single vote for all accounts...');
  await voteCycle();
  logger.info('✅ Single vote cycle complete.');
}
