import config from './config.js';
import logger from './logger.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

/**
 * Escape special characters for Telegram Markdown
 */
function escMd(text) {
  if (!text) return '';
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Send a message via Telegram Bot API
 * @param {string} text - Message text (supports Markdown)
 * @param {object} opts
 * @param {boolean} opts.silent - Send without notification sound
 */
export async function sendTelegram(text, { silent = false } = {}) {
  const { telegramBotToken, telegramChatId } = config;

  if (!telegramBotToken || !telegramChatId) {
    logger.debug('Telegram not configured, skipping notification.');
    return false;
  }

  try {
    const url = `${TELEGRAM_API}${telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: 'Markdown',
        disable_notification: silent,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      // If message is too long, truncate and retry
      if (res.status === 400 && body.includes('too long')) {
        logger.debug('Telegram message too long, truncating...');
        const truncated = text.substring(0, 3900) + '\n\n... (truncated)';
        const res2 = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: truncated,
            parse_mode: 'Markdown',
            disable_notification: silent,
          }),
        });
        if (!res2.ok) {
          // Try plain text as last resort
          const res3 = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramChatId,
              text: truncated.replace(/[*_`\\]/g, ''),
              disable_notification: silent,
            }),
          });
          return res3.ok;
        }
        return res2.ok;
      }
      // If Markdown fails, retry as plain text
      if (res.status === 400 && body.includes('parse entities')) {
        logger.debug('Telegram Markdown failed, retrying as plain text...');
        const res2 = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: text.replace(/[*_`\\]/g, ''),
            disable_notification: silent,
          }),
        });
        if (!res2.ok) {
          logger.warn(`Telegram plain text also failed (${res2.status})`);
        }
        return res2.ok;
      }
      logger.warn(`Telegram API error (${res.status}): ${body.substring(0, 200)}`);
      return false;
    }

    logger.debug('📨 Telegram notification sent.');
    return true;
  } catch (err) {
    logger.warn(`Telegram send failed: ${err.message}`);
    return false;
  }
}

/**
 * Prefix a message with account label
 */
function acctPrefix(accountId) {
  return accountId ? `[${accountId}] ` : '';
}

/**
 * Notify vote success (per-account)
 */
export async function notifyVoteSuccess(details = {}, accountId = null) {
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const prefix = accountId ? `[${accountId}] ` : '';
  const roundDisplay = details.round && details.round.length > 30
    ? details.round.substring(0, 30) + '...'
    : (details.round || 'N/A');
  const msg = [
    `✅ ${prefix}*VOTE BERHASIL*`,
    '',
    `🗳️ Asset: *${details.asset || 'N/A'}*`,
    `🎯 Strategy: \`${details.strategy || 'N/A'}\``,
    `📅 Round: ${roundDisplay}`,
    `🕐 Waktu: ${time}`,
    details.note ? `📝 Note: ${details.note}` : '',
  ].filter(Boolean).join('\n');

  return sendTelegram(msg);
}

/**
 * Notify vote failed (per-account)
 */
export async function notifyVoteFailed(details = {}, accountId = null) {
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const prefix = accountId ? `[${accountId}] ` : '';
  // Truncate and escape error message to prevent Telegram formatting issues
  const errorMsg = escMd(String(details.error || 'Unknown').substring(0, 150));
  const msg = [
    `❌ ${prefix}*VOTE GAGAL*`,
    '',
    `⚠️ Error: ${errorMsg}`,
    `🎯 Strategy: \`${details.strategy || 'N/A'}\``,
    `🕐 Waktu: ${time}`,
    `🔄 Attempt: ${details.attempt || '?'}/${details.maxAttempts || '?'}`,
    '',
    details.willRetry ? '⏳ Akan retry...' : '🛑 Semua retry gagal.',
  ].join('\n');

  return sendTelegram(msg);
}

/**
 * Notify session expired (per-account)
 */
export async function notifySessionExpired(accountId = null) {
  const prefix = accountId ? `[${accountId}] ` : '';
  const format = accountId ? `${accountId} eyJ...` : 'eyJ...';
  const msg = [
    `🔑 ${prefix}*SESSION EXPIRED*`,
    '',
    `Session login${accountId ? ` akun *${accountId}*` : ''} sudah expired.`,
    '',
    '*Cara update (langsung di sini):*',
    '1. Buka Chrome → login https://runway.edel.finance',
    '2. Tekan F12 → Network → Refresh halaman',
    '3. Klik request pertama → cari header Cookie',
    '4. Copy value cookie-nya',
    `5. *Paste di chat ini* dengan format:`,
    `   \`${format}\``,
    '',
    '💡 Format cookie:',
    `• \`${accountId || 'A1'} edel_session=eyJ...;cookie2=xxx\``,
    `• \`${accountId || 'A1'} eyJhbGci...\``,
    '',
    '📱 Bot sedang menunggu cookie dari kamu...',
  ].join('\n');

  return sendTelegram(msg);
}

/**
 * Notify bot started (multi-account)
 */
export async function notifyBotStarted(accountCount = 1) {
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const totalMin = config.voteIntervalMinutes + config.voteBufferMinutes;
  const msg = [
    '🤖 *BOT STARTED*',
    '',
    `👥 Accounts: ${accountCount}`,
    `🎯 Strategy: \`${config.voteStrategy}\``,
    `📅 Interval: ${config.voteIntervalMinutes} min + ${config.voteBufferMinutes} min buffer = ${totalMin} min`,
    `🔄 Retry: setiap ${config.retryIntervalMinutes} min`,
    `🕐 Started: ${time}`,
    '',
    'Bot akan vote otomatis semua akun dengan dynamic scheduling.',
  ].join('\n');

  return sendTelegram(msg);
}

/**
 * Notify next vote scheduled (per-account)
 */
export async function notifyNextVote(nextTime, accountId = null) {
  const nextStr = nextTime
    ? nextTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    : 'Unknown';

  const now = new Date();
  const diffMs = nextTime ? nextTime.getTime() - now.getTime() : 0;
  const diffMin = Math.round(diffMs / 60000);

  const prefix = accountId ? `[${accountId}] ` : '';
  const msg = [
    `⏰ ${prefix}*NEXT VOTE*`,
    '',
    `🕐 Vote selanjutnya: ${nextStr}`,
    `⏳ Dalam ${diffMin} menit`,
    '📡 Bot tetap berjalan...',
  ].join('\n');

  return sendTelegram(msg, { silent: true });
}

/**
 * Notify already voted (per-account)
 */
export async function notifyAlreadyVoted(message, accountId = null) {
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const prefix = accountId ? `[${accountId}] ` : '';
  const msg = [
    `ℹ️ ${prefix}*SUDAH VOTED*`,
    '',
    `📝 Status: ${message || 'Already voted'}`,
    `🕐 Waktu cek: ${time}`,
    '',
    '⏰ Akan coba lagi di jadwal berikutnya.',
  ].join('\n');

  return sendTelegram(msg, { silent: true });
}

/**
 * Notify all-accounts summary after a vote cycle
 */
export async function notifyVoteSummary(results) {
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const lines = results.map(r => {
    const emoji = r.status === 'voted' ? '✅'
      : r.status === 'already_voted' ? '✅'
      : r.status === 'expired' ? '🔑'
      : r.status === 'failed' ? '❌'
      : '⏳';
    const detail = r.status === 'voted' ? (r.asset || 'done')
      : r.status === 'already_voted' ? 'already voted'
      : r.status === 'expired' ? 'SESSION EXPIRED'
      : r.status === 'failed' ? (r.error || 'error')
      : 'waiting';
    return `${emoji} *${r.accountId}*: ${detail}`;
  });

  const msg = [
    '📊 *VOTE CYCLE SUMMARY*',
    '',
    ...lines,
    '',
    `🕐 Waktu: ${time}`,
  ].join('\n');

  return sendTelegram(msg, { silent: true });
}

export default {
  sendTelegram,
  notifyVoteSuccess,
  notifyVoteFailed,
  notifySessionExpired,
  notifyBotStarted,
  notifyNextVote,
  notifyAlreadyVoted,
  notifyVoteSummary,
};
