import cron from 'node-cron';
import config from '../utils/config.js';
import logger, { logSeparator } from '../utils/logger.js';
import { performVote } from '../bot/voter.js';
import {
  notifyVoteSuccess,
  notifyVoteFailed,
  notifySessionExpired,
  notifyBotStarted,
  notifyNextVote,
  notifyAlreadyVoted,
  sendTelegram,
} from '../utils/telegram.js';

/**
 * Execute a single vote cycle with retry logic
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

        // Send Telegram notification
        if (result.details?.note?.includes('Already submitted')) {
          await notifyAlreadyVoted(result.details.note);
        } else if (result.details?.note) {
          // Informational (waiting, no round, etc.)
          await notifyAlreadyVoted(result.details.note);
        } else {
          await notifyVoteSuccess(result.details);
        }
        await notifyNextVote();
        return;
      }

      // Check if session expired
      if (result.details?.sessionExpired) {
        logger.error('🔑 Session expired. Need re-import.');
        await notifySessionExpired();
        return;
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
}

/**
 * Start the cron scheduler
 */
export async function startScheduler() {
  const schedule = config.cronSchedule;

  // Validate cron expression
  if (!cron.validate(schedule)) {
    logger.error(`❌ Invalid cron schedule: "${schedule}"`);
    process.exit(1);
  }

  console.log('');
  console.log('\x1b[36m' +
  `                                                                                              
  ▄▄▄▄▄▄▄                               ▄▄                     ██   ▄▄▄   ▄▄▄  ▄▄▄▄▄▄▄   ▄▄▄▄   
  ███▀▀███▄        ██         ▄▄        ██                     ██   ███   ███ ███▀▀▀▀▀ ▄██▀▀██▄ 
  ███▄▄███▀  ▀▀█▄ ▀██▀▀ ▄███▄ ██ ▄█▀ ▄████ ████▄ ▄████ ████▄   ██   █████████ ███      ███  ███ 
  ███  ███▄ ▄█▀██  ██   ██ ██ ████   ██ ██ ██ ▀▀ ██ ██ ██ ██   ██   ███▀▀▀███ ███      ███▀▀███ 
  ████████▀ ▀█▄██  ██   ▀███▀ ██ ▀█▄ ▀████ ██    ▀████ ██ ██   ██   ███   ███ ▀███████ ███  ███ 
                                                    ██         ██                               
                                                  ▀▀▀                                           ` + '\x1b[0m');
  console.log('');
  console.log('\x1b[90m  ──────────────────────────────────────────────────────────────────────────────────\x1b[0m');
  console.log('\x1b[33m   ⚡ Edel Runway Desk — Auto Vote Bot v2.0\x1b[0m');
  console.log('\x1b[90m   🌐 Pure HTTP Mode — No Browser Needed\x1b[0m');
  console.log('\x1b[90m  ──────────────────────────────────────────────────────────────────────────────────\x1b[0m');
  console.log('');
  logger.info(`📅 Schedule  : ${schedule}`);
  logger.info(`🎯 Strategy  : ${config.voteStrategy}`);
  logger.info(`🔄 Retries   : ${config.maxRetries}`);
  logger.info(`📨 Telegram  : ${config.telegramBotToken ? 'Configured ✅' : 'Not configured ⚠️'}`);
  logger.info('');

  // Send Telegram notification that bot started
  await notifyBotStarted();

  logger.info('▶️  Running initial vote cycle...');
  await voteCycle();

  logger.info('');
  logger.info('⏳ Waiting for next scheduled run...');
  logger.info(`   (Schedule: "${schedule}")`);

  // Schedule recurring runs
  const job = cron.schedule(schedule, async () => {
    try {
      await voteCycle();
    } catch (err) {
      logger.error(`Scheduled vote cycle error: ${err.message}`);
    }
  }, {
    timezone: 'Asia/Jakarta',
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('');
    logger.info('🛑 Bot stopping...');
    job.stop();
    const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    await sendTelegram(`🛑 *BOT STOPPED*\n\n🕐 Waktu: ${time}`);
    logger.info('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return job;
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
