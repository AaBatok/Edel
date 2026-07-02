import config from '../utils/config.js';
import logger, { logSeparator } from '../utils/logger.js';
import { performVote } from '../bot/voter.js';
import { waitForCookieViaTelegram } from '../auth/telegram-import.js';
import { initDisplay, updateStatus, destroyDisplay } from '../utils/display.js';
import {
  notifyVoteSuccess,
  notifyVoteFailed,
  notifySessionExpired,
  notifyBotStarted,
  notifyNextVote,
  notifyAlreadyVoted,
  sendTelegram,
} from '../utils/telegram.js';

// Track whether we already sent a session-expired notification
// to avoid spamming the user on every retry
let sessionExpiredNotified = false;

// Track active timer for graceful shutdown
let nextVoteTimer = null;

/**
 * Execute a single vote cycle with retry logic.
 * Returns a status string for scheduling decisions:
 *   'voted'         → successful vote
 *   'already_voted' → already submitted for this round
 *   'waiting'       → no round available / allocation pending
 *   'failed'        → error / session expired
 */
async function voteCycle() {
  logSeparator();
  logger.info(`⏰ Vote cycle started at ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);

  let lastError = null;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    logger.info(`🔄 Attempt ${attempt}/${config.maxRetries}`);

    try {
      const result = await performVote();

      if (result.success) {
        logger.info('🎉 Vote cycle completed successfully!');

        // Send Telegram notification based on result type
        if (result.details?.note?.includes('Already submitted')) {
          await notifyAlreadyVoted(result.details.note);
          return 'already_voted';
        } else if (result.details?.note) {
          // Informational (waiting, no round, etc.)
          await notifyAlreadyVoted(result.details.note);
          return 'waiting';
        } else {
          await notifyVoteSuccess(result.details);
          return 'voted';
        }
      }

      // Check if session expired → try Telegram re-import
      if (result.details?.sessionExpired) {
        logger.error('🔑 Session expired. Mencoba import via Telegram...');

        // Only send notification once (avoid spam on retries)
        if (!sessionExpiredNotified) {
          sessionExpiredNotified = true;
          await notifySessionExpired();
        }

        // Wait for user to paste cookie in Telegram (up to 60 min)
        const imported = await waitForCookieViaTelegram(60);
        if (imported) {
          logger.info('🔄 Session refreshed via Telegram! Retrying vote...');
          sessionExpiredNotified = false;
          // Retry the vote with fresh session
          const retryResult = await performVote();
          if (retryResult.success && !retryResult.details?.note) {
            await notifyVoteSuccess(retryResult.details);
            return 'voted';
          } else if (retryResult.success) {
            await notifyAlreadyVoted(retryResult.details?.note || 'Retried after re-login');
            return retryResult.details?.note?.includes('Already submitted') ? 'already_voted' : 'waiting';
          }
        }

        // Import failed or vote after import failed
        return 'failed';
      }

      lastError = result.details?.error;
      logger.warn(`⚠️  Attempt ${attempt} failed: ${lastError}`);

      await notifyVoteFailed({
        ...result.details,
        attempt,
        maxAttempts: config.maxRetries,
        willRetry: attempt < config.maxRetries,
      });
    } catch (err) {
      lastError = err.message;
      logger.error(`💥 Attempt ${attempt} crashed: ${err.message}`);

      await notifyVoteFailed({
        error: err.message,
        strategy: config.voteStrategy,
        attempt,
        maxAttempts: config.maxRetries,
        willRetry: attempt < config.maxRetries,
      });
    }

    // Wait before retry (exponential backoff)
    if (attempt < config.maxRetries) {
      const delay = config.retryDelay * attempt;
      logger.info(`⏳ Waiting ${delay / 1000}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.error(`❌ All ${config.maxRetries} attempts failed. Last error: ${lastError}`);
  return 'failed';
}

/**
 * Determine next delay (in ms) based on vote cycle result.
 *
 * - 'voted': full interval + buffer (default 62 min)
 *     → vote berhasil, tunggu 1 jam + 2 menit agar EDELx unlock
 * - 'already_voted' / 'waiting': shorter retry (default 5 min)
 *     → belum siap, coba lagi sebentar lagi
 * - 'failed': shorter retry (default 5 min)
 *     → error, coba lagi sebentar lagi
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
 * Schedule the next vote using dynamic setTimeout.
 *
 * Unlike fixed cron which runs at XX:00 every hour,
 * this schedules relative to the LAST vote time.
 *
 * Example: vote at 22:37 → next at 23:39 (62 min later)
 *
 * @param {number} delayMs - Delay in milliseconds until next vote
 * @returns {Date} The scheduled next vote time
 */
function scheduleNextVote(delayMs) {
  if (nextVoteTimer) {
    clearTimeout(nextVoteTimer);
    nextVoteTimer = null;
  }

  const nextTime = new Date(Date.now() + delayMs);
  const nextStr = nextTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const delayMin = Math.round(delayMs / 60000);

  // Update TUI header with next vote info
  const nextHHmm = nextTime.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  updateStatus({
    status: 'LIVE',
    nextVote: nextHHmm,
    countdown: `${delayMin}m lagi`,
  });

  logger.info(`⏰ Next vote scheduled: ${nextStr} (in ${delayMin} minutes)`);

  nextVoteTimer = setTimeout(async () => {
    try {
      const result = await voteCycle();
      const nextDelay = getNextDelay(result);
      const scheduledTime = scheduleNextVote(nextDelay);
      await notifyNextVote(scheduledTime);
    } catch (err) {
      logger.error(`Scheduled vote cycle error: ${err.message}`);
      const retryDelay = config.retryIntervalMinutes * 60 * 1000;
      const scheduledTime = scheduleNextVote(retryDelay);
      await notifyNextVote(scheduledTime);
    }
  }, delayMs);

  return nextTime;
}

/**
 * Start the dynamic vote scheduler.
 *
 * Flow:
 *   1. Run initial vote immediately
 *   2. Based on result, schedule next vote dynamically:
 *      - Vote sukses → 62 min (1 jam + 2 min buffer)
 *      - Belum siap  → 5 min retry
 *   3. Repeat forever until bot stopped
 */
export async function startScheduler() {
  const totalMin = config.voteIntervalMinutes + config.voteBufferMinutes;

  // Initialize TUI with sticky header
  initDisplay({
    strategy: config.voteStrategy,
    interval: String(totalMin),
  });

  logger.info(`📅 Interval : ${config.voteIntervalMinutes}m + ${config.voteBufferMinutes}m buffer = ${totalMin}m`);
  logger.info(`🔄 Retry    : every ${config.retryIntervalMinutes}m`);
  logger.info(`🎯 Strategy : ${config.voteStrategy}`);
  logger.info(`📨 Telegram : ${config.telegramBotToken ? 'Configured ✅' : 'Not configured ⚠️'}`);
  logger.info('');

  // Send Telegram notification that bot started
  await notifyBotStarted();

  logger.info('▶️  Running initial vote cycle...');
  const result = await voteCycle();

  // Schedule next vote dynamically based on result
  const nextDelay = getNextDelay(result);
  const nextTime = scheduleNextVote(nextDelay);
  await notifyNextVote(nextTime);

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
 * Run a single vote (no scheduling)
 */
export async function runSingleVote() {
  logSeparator();
  logger.info('🗳️  Running single vote...');
  await voteCycle();
  logger.info('✅ Single vote cycle complete.');
}
