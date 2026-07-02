import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Load .env from project root
dotenv.config({ path: path.join(ROOT, '.env') });

const config = {
  // Voting
  voteStrategy: process.env.VOTE_STRATEGY || 'smart',
  cronSchedule: process.env.CRON_SCHEDULE || '0 */1 * * *', // legacy, kept for reference

  // Dynamic scheduling (replaces fixed cron)
  voteIntervalMinutes: parseInt(process.env.VOTE_INTERVAL_MINUTES || '60', 10),
  voteBufferMinutes: parseInt(process.env.VOTE_BUFFER_MINUTES || '2', 10),
  retryIntervalMinutes: parseInt(process.env.RETRY_INTERVAL_MINUTES || '5', 10),

  // Browser
  headless: process.env.HEADLESS === 'true',
  slowMo: parseInt(process.env.SLOW_MO || '500', 10),
  pageTimeout: parseInt(process.env.PAGE_TIMEOUT || '30000', 10),

  // Retry
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  retryDelay: parseInt(process.env.RETRY_DELAY || '5000', 10),

  // Screenshots
  saveScreenshots: process.env.SAVE_SCREENSHOTS !== 'false',

  // Telegram Notifications
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // URLs
  baseUrl: process.env.BASE_URL || 'https://runway.edel.finance',
  listingCallsUrl: `${process.env.BASE_URL || 'https://runway.edel.finance'}/listing-calls`,
  loginUrl: `${process.env.BASE_URL || 'https://runway.edel.finance'}/login`,

  // Paths
  rootDir: ROOT,
  sessionDir: path.join(ROOT, 'sessions'),
  screenshotDir: path.join(ROOT, 'screenshots'),
  logDir: path.join(ROOT, 'logs'),
  sessionFile: path.join(ROOT, 'sessions', 'state.json'),

  // Multi-account
  accountsFile: path.join(ROOT, 'accounts.json'),
  maxAccounts: parseInt(process.env.MAX_ACCOUNTS || '20', 10),
  delayBetweenAccounts: parseInt(process.env.DELAY_BETWEEN_ACCOUNTS || '3000', 10),
};

/**
 * Validate required configuration
 */
export function validateConfig() {
  const validStrategies = ['random', 'smart', 'first', 'second'];
  if (!validStrategies.includes(config.voteStrategy)) {
    throw new Error(
      `Invalid VOTE_STRATEGY "${config.voteStrategy}". Must be one of: ${validStrategies.join(', ')}`
    );
  }
  return true;
}

export default config;
