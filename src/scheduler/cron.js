import config from '../utils/config.js';
import logger, { logSeparator } from '../utils/logger.js';
import { performVote } from '../bot/voter.js';
import { getBalance, getPortfolio, getProfile } from '../api/client.js';
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

// Cookie import queue: import cookies instantly, vote after 30s cooldown
let cookieVoteQueue = [];
let cookieVoteTimer = null;

/**
 * Process queued accounts after cookie import cooldown.
 * Runs votes for all queued accounts sequentially.
 */
async function processCookieVoteQueue() {
  cookieVoteTimer = null;
  if (cookieVoteQueue.length === 0) return;

  const accountIds = [...cookieVoteQueue];
  cookieVoteQueue = [];

  logger.info(`🍪 Cookie cooldown selesai. Voting ${accountIds.length} akun: ${accountIds.join(', ')}`);
  await sendTelegram([
    `▶️ *MULAI VOTE*`,
    '',
    `🍪 ${accountIds.length} akun: ${accountIds.join(', ')}`,
  ].join('\n'));

  const { getAccount } = await import('../accounts/manager.js');

  for (const accountId of accountIds) {
    const account = getAccount(accountId);
    if (!account) continue;

    try {
      const result = await voteForAccount(account);
      const nextDelay = getNextDelay(result.status);

      // For 'already_voted', calculate nextVote from the ORIGINAL lastVote time,
      // not from now. This preserves the correct vote schedule after cookie import.
      let baseTime = Date.now();
      let newLastVote = new Date().toISOString();

      if (result.status === 'already_voted' && account.lastVote) {
        baseTime = new Date(account.lastVote).getTime();
        newLastVote = account.lastVote; // preserve original lastVote
        logger.info(`[${accountId}] 📅 Keeping original lastVote: ${account.lastVote}`);
      }

      let nextVoteTime = new Date(baseTime + nextDelay);

      // If calculated nextVote is in the past, vote can happen soon
      if (nextVoteTime.getTime() < Date.now()) {
        nextVoteTime = new Date(Date.now() + 30 * 1000); // 30 seconds from now
        logger.info(`[${accountId}] ⚡ nextVote was in the past, scheduling in 30s`);
      }

      updateAccountDb(accountId, {
        lastVote: newLastVote,
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

  // Reschedule next cycle based on updated account times
  const nextDelay = getEarliestNextVoteDelay();
  scheduleNextVote(nextDelay);
}

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
 * Find the earliest nextVote time among all enabled accounts.
 * Returns delay in ms from now. Minimum 30 seconds.
 */
function getEarliestNextVoteDelay() {
  const accounts = getEnabledAccounts();
  const now = Date.now();
  let earliest = Infinity;

  for (const acct of accounts) {
    if (acct.nextVote) {
      const t = new Date(acct.nextVote).getTime();
      if (t < earliest) earliest = t;
    }
  }

  if (earliest === Infinity) {
    // No nextVote set, use retry interval
    return config.retryIntervalMinutes * 60 * 1000;
  }

  const delay = earliest - now;
  return Math.max(delay, 30 * 1000); // minimum 30s
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
        // Don't notify Telegram for 'already voted' — avoids spam on retries
        return { accountId, status: 'already_voted', details: result.details };
      } else if (result.details?.note) {
        // Don't notify Telegram for 'waiting' status
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

    // For 'already_voted', calculate nextVote from the ORIGINAL lastVote time,
    // not from now. This preserves the correct vote schedule.
    let baseTime = now.getTime();
    let newLastVote = now.toISOString();

    if (lastResult.status === 'already_voted' && account.lastVote) {
      baseTime = new Date(account.lastVote).getTime();
      newLastVote = account.lastVote; // preserve original lastVote
      logger.info(`[${account.id}] 📅 Keeping original lastVote: ${account.lastVote}`);
    }

    let nextVoteTime = new Date(baseTime + nextDelay);

    // If calculated nextVote is in the past, vote can happen soon
    if (nextVoteTime.getTime() < now.getTime()) {
      nextVoteTime = new Date(now.getTime() + 30 * 1000); // 30 seconds from now
      logger.info(`[${account.id}] ⚡ nextVote was in the past, scheduling in 30s`);
    }

    updateAccountDb(account.id, {
      lastVote: newLastVote,
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

  // Send summary ONLY if at least one account ACTUALLY ran and voted/failed this cycle
  // Exclude skipped accounts (they carry old status like 'voted' from previous cycle)
  const hasRealActivity = results.some(r =>
    r.details?.note !== 'skipped'
    && (r.status === 'voted' || r.status === 'failed' || r.status === 'expired')
  );
  if (results.length > 1 && hasRealActivity) {
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

  // Return is kept for backwards compat but scheduling now uses per-account nextVote
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
      // Schedule based on EARLIEST per-account nextVote
      const nextDelay = getEarliestNextVoteDelay();
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

  // Schedule next vote based on EARLIEST per-account nextVote
  const nextDelay = getEarliestNextVoteDelay();
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

        // ── Handle /balance command ──
        if (text === '/balance' || text === '/bal') {
          await handleBalanceCommand();
          continue;
        }

        // ── Handle /status command ──
        if (text === '/status') {
          await handleStatusCommand();
          continue;
        }

        // ── Handle /help command ──
        if (text === '/help' || text === '/start') {
          await sendTelegram([
            '🤖 *EDEL BOT — COMMANDS*',
            '',
            '💰 /balance — Cek balance semua akun',
            '📊 /status — Status bot & akun',
            '❓ /help — Tampilkan bantuan ini',
            '',
            '🍪 *Import Cookie:*',
            '`A1 eyJhbGci...`',
            '`A2 edel_session=eyJ...`',
          ].join('\n'));
          continue;
        }

        // Parse cookie entries: supports single "A1 cookie" or bulk:
        // "A2\ncookie\nA3\ncookie\n..."  or  "A2 cookie\nA3 cookie\n..."
        const { updateAccountSession, getAccount } = await import('../accounts/manager.js');

        // Split by account label pattern to find all entries
        const entries = [];
        const lines = text.split(/\n/);
        let currentId = null;
        let currentCookie = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Check if line starts with account ID (e.g. "A1" or "A1 cookie...")
          const idMatch = trimmed.match(/^(A\d+)\s*(.*)/i);
          if (idMatch) {
            // Save previous entry
            if (currentId && currentCookie.trim()) {
              entries.push({ id: currentId, cookie: currentCookie.trim() });
            }
            currentId = idMatch[1].toUpperCase();
            currentCookie = idMatch[2] || ''; // rest of line after ID (if any)
          } else if (currentId) {
            // Continuation of cookie data for current account
            currentCookie += (currentCookie ? '; ' : '') + trimmed;
          }
        }
        // Don't forget the last entry
        if (currentId && currentCookie.trim()) {
          entries.push({ id: currentId, cookie: currentCookie.trim() });
        }

        if (entries.length === 0) continue;

        // Delete cookie message for security (once, before processing)
        try {
          await fetch(`${TELEGRAM_API}${telegramBotToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: telegramChatId, message_id: msg.message_id }),
          });
        } catch (e) {
          // ignore
        }

        // Import cookies instantly (no voting yet)
        const imported = [];
        const failed = [];

        for (const entry of entries) {
          const cookies = parseCookieInput(entry.cookie);
          if (!cookies) {
            failed.push(`${entry.id}: format cookie salah`);
            continue;
          }

          const account = getAccount(entry.id);
          if (!account) {
            failed.push(`${entry.id}: akun tidak ditemukan`);
            continue;
          }

          updateAccountSession(entry.id, cookies);
          sessionExpiredNotified.delete(entry.id);
          logger.info(`🍪 [${entry.id}] Cookie imported!`);
          imported.push(entry.id);

          // Add to vote queue (deduplicate)
          if (!cookieVoteQueue.includes(entry.id)) {
            cookieVoteQueue.push(entry.id);
          }
        }

        // Send import confirmation immediately
        const summaryLines = [];
        if (imported.length > 0) {
          summaryLines.push(`✅ *SESSION UPDATED*`);
          summaryLines.push('');
          summaryLines.push(`🍪 ${imported.length} akun: ${imported.join(', ')}`);
          summaryLines.push('');
          summaryLines.push(`⏳ Menunggu 30 detik untuk cookie lainnya...`);
          summaryLines.push(`📋 Antrian vote: ${cookieVoteQueue.join(', ')}`);
        }
        if (failed.length > 0) {
          summaryLines.push('');
          summaryLines.push(`❌ Gagal: ${failed.join(', ')}`);
        }
        if (summaryLines.length > 0) {
          await sendTelegram(summaryLines.join('\n'));
        }

        // Reset the 30s cooldown timer — vote starts after no new cookies for 30s
        if (cookieVoteTimer) clearTimeout(cookieVoteTimer);
        cookieVoteTimer = setTimeout(() => processCookieVoteQueue(), 30 * 1000);
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
 * Handle /balance command from Telegram.
 * Checks all accounts' balances and sends a formatted reply.
 */
async function handleBalanceCommand() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    await sendTelegram('📋 Belum ada akun. Tambah akun dulu.');
    return;
  }

  await sendTelegram(`⏳ Mengecek balance ${accounts.length} akun...`);

  const lines = ['💰 *BALANCE — SEMUA AKUN*', ''];
  let totalEdelx = 0;
  let totalCC = 0;
  let okCount = 0;
  let expiredCount = 0;

  for (const account of accounts) {
    try {
      let balanceData = null;
      let portfolioErr = null;
      let balanceErr = null;

      // Try /portfolio first
      try {
        balanceData = await getPortfolio(account.sessionFile);
      } catch (e) {
        portfolioErr = e.message.substring(0, 100);
      }

      // Fallback to /balances
      if (!balanceData) {
        try {
          balanceData = await getBalance(null, account.sessionFile);
        } catch (e) {
          balanceErr = e.message.substring(0, 100);
        }
      }

      // DEBUG: Send raw response for first account to see format
      if (account.id === accounts[0].id) {
        const debugLines = [
          `🔍 *DEBUG ${account.id}*`,
          '',
          `Portfolio err: ${portfolioErr || 'none'}`,
          `Balance err: ${balanceErr || 'none'}`,
          '',
          `Type: ${typeof balanceData}`,
          `IsArray: ${Array.isArray(balanceData)}`,
          `Keys: ${balanceData ? Object.keys(balanceData).join(', ') : 'null'}`,
          '',
          `Raw (300 chars):`,
          `\`${JSON.stringify(balanceData).substring(0, 300)}\``,
        ];
        await sendTelegram(debugLines.join('\n'));
      }

      // Parse balance data
      let edelx = 0;
      let edelxAvail = 0;
      let edelxLocked = 0;
      let cc = 0;
      let ccAvail = 0;

      if (balanceData) {
        const items = balanceData.balances || balanceData.instruments || balanceData.holdings
          || (Array.isArray(balanceData) ? balanceData : null);

        if (items && Array.isArray(items)) {
          for (const item of items) {
            const id = (item.instrumentId || item.instrument || item.ticker || item.symbol || item.id || '').toUpperCase();
            const total = parseFloat(item.total || item.balance || item.amount || item.quantity || 0);
            const avail = parseFloat(item.available || item.unlocked || item.free || 0);
            const locked = parseFloat(item.locked || item.staked || item.allocated || 0);

            if (id.includes('EDELX') || id.includes('EDEL')) {
              edelx = total || (avail + locked);
              edelxAvail = avail;
              edelxLocked = locked;
            } else if (id === 'CC') {
              cc = total || (avail + locked);
              ccAvail = avail;
            }
          }
        } else if (typeof balanceData === 'object') {
          for (const [key, val] of Object.entries(balanceData)) {
            const k = key.toUpperCase();
            if (k.includes('EDELX') || k.includes('EDEL')) {
              if (typeof val === 'number') { edelx = val; edelxAvail = val; }
              else if (val && typeof val === 'object') {
                edelx = parseFloat(val.total || val.balance || 0);
                edelxAvail = parseFloat(val.available || val.unlocked || 0);
                edelxLocked = parseFloat(val.locked || val.staked || 0);
                if (!edelx) edelx = edelxAvail + edelxLocked;
              }
            } else if (k === 'CC') {
              if (typeof val === 'number') { cc = val; ccAvail = val; }
              else if (val && typeof val === 'object') {
                cc = parseFloat(val.total || val.balance || 0);
                ccAvail = parseFloat(val.available || val.unlocked || 0);
                if (!cc) cc = ccAvail;
              }
            }
          }
        }
      }

      totalEdelx += edelx;
      totalCC += cc;
      okCount++;

      lines.push(`✅ *${account.id}*`);
      lines.push(`   💎 EDELx: \`${edelx.toFixed(2)}\` _(${edelxAvail.toFixed(2)} avail / ${edelxLocked.toFixed(2)} locked)_`);
      lines.push(`   🪙 CC: \`${cc.toFixed(2)}\` _(${ccAvail.toFixed(2)} avail)_`);

    } catch (err) {
      const isSession = err.message.includes('SESSION_EXPIRED');
      if (isSession) {
        lines.push(`🔑 *${account.id}* — Session expired`);
        expiredCount++;
      } else {
        lines.push(`❌ *${account.id}* — Error: ${err.message.substring(0, 50)}`);
      }
    }
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`📊 *TOTAL (${accounts.length} akun)*`);
  lines.push(`   💎 EDELx: \`${totalEdelx.toFixed(2)}\``);
  lines.push(`   🪙 CC: \`${totalCC.toFixed(2)}\``);

  if (expiredCount > 0) {
    lines.push('');
    lines.push(`⚠️ ${expiredCount} akun session expired`);
  }

  lines.push('');
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  lines.push(`🕐 ${time}`);

  await sendTelegram(lines.join('\n'));
}

/**
 * Handle /status command from Telegram.
 */
async function handleStatusCommand() {
  const allAccounts = getAccounts();
  const enabled = getEnabledAccounts();
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const lines = ['📊 *BOT STATUS*', ''];
  lines.push(`👥 Akun: ${enabled.length} enabled / ${allAccounts.length} total`);
  lines.push(`🎯 Strategy: \`${config.voteStrategy}\``);
  lines.push(`📅 Interval: ${config.voteIntervalMinutes}m + ${config.voteBufferMinutes}m buffer`);
  lines.push('');

  for (const acc of allAccounts) {
    const emoji = acc.enabled ? '✅' : '⛔';
    const lastVote = acc.lastVote
      ? new Date(acc.lastVote).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : 'never';
    const status = acc.lastVoteStatus || 'idle';
    lines.push(`${emoji} *${acc.id}* | ${status} | Last: ${lastVote}`);
  }

  lines.push('');
  lines.push(`🕐 ${time}`);

  await sendTelegram(lines.join('\n'));

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
