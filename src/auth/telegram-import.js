/**
 * Telegram-based session import.
 *
 * When the bot detects SESSION_EXPIRED, it sends a Telegram notification
 * asking the user to paste the cookie. The bot then polls Telegram
 * for incoming messages, parses the cookie, and updates the session.
 *
 * This eliminates the need to SSH into the VPS for re-import.
 */
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { saveSessionRaw } from './session.js';
import { sendTelegram } from '../utils/telegram.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

/**
 * Parse cookie string from a Telegram message.
 *
 * Accepts these formats:
 *   1. Full cookie string: "edel_session=eyJ...; _ga=GA1..."
 *   2. With prefix: "Cookie: edel_session=eyJ..."
 *   3. Just the JWT token: "eyJhbGciOiJ..."
 *
 * @param {string} text - Raw message text
 * @returns {Array|null} Parsed cookies array or null
 */
function parseCookieFromMessage(text) {
  if (!text) return null;

  const cleaned = text.trim();

  // Ignore short messages and bot commands
  if (cleaned.length < 20) return null;
  if (cleaned.startsWith('/')) return null;

  // Case 1: Cookie string containing edel_session=xxx
  if (cleaned.includes('edel_session=')) {
    const cookies = [];
    const raw = cleaned.replace(/^Cookie:\s*/i, '').trim();
    const pairs = raw.split(/;\s*/);

    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (!name) continue;

      cookies.push({
        name,
        value,
        domain: 'runway.edel.finance',
        path: '/',
        expires: Date.now() / 1000 + 86400 * 30,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      });
    }

    if (cookies.some((c) => c.name === 'edel_session')) {
      return cookies;
    }
  }

  // Case 2: Just the JWT token value (starts with eyJ, base64 encoded JSON)
  if (cleaned.startsWith('eyJ') && cleaned.length > 50 && !cleaned.includes(' ')) {
    return [
      {
        name: 'edel_session',
        value: cleaned,
        domain: 'runway.edel.finance',
        path: '/',
        expires: Date.now() / 1000 + 86400 * 30,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      },
    ];
  }

  return null;
}

/**
 * Poll Telegram for cookie messages from the user.
 *
 * Uses Telegram Bot API long polling (getUpdates) to wait for
 * the user to paste a cookie string in the chat.
 *
 * IMPORTANT: The offset is persisted between calls so that cookie
 * messages sent between wait cycles are NOT lost.
 *
 * @param {number} timeoutMinutes - Max time to wait (default: 60 min)
 * @returns {boolean} true if cookie was received and saved
 */

// Persistent offset — only initialized once on first call
let _telegramOffset = 0;
let _offsetInitialized = false;

export async function waitForCookieViaTelegram(timeoutMinutes = 60) {
  const { telegramBotToken, telegramChatId } = config;

  if (!telegramBotToken || !telegramChatId) {
    logger.error('❌ Telegram not configured. Cannot wait for cookie.');
    return false;
  }

  logger.info('📱 Menunggu cookie via Telegram...');
  logger.info(`   Timeout: ${timeoutMinutes} menit`);

  const startTime = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;

  // Only skip old messages on the very FIRST call after bot start.
  // Subsequent calls reuse the offset so no messages are lost.
  if (!_offsetInitialized) {
    _offsetInitialized = true;
    try {
      const initUrl = `${TELEGRAM_API}${telegramBotToken}/getUpdates?offset=-1&limit=1`;
      const initRes = await fetch(initUrl);
      const initData = await initRes.json();
      if (initData.ok && initData.result.length > 0) {
        _telegramOffset = initData.result[initData.result.length - 1].update_id + 1;
      }
    } catch (e) {
      logger.debug(`Init offset error: ${e.message}`);
    }
  }

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Long polling — wait up to 30 seconds for new messages
      const url = `${TELEGRAM_API}${telegramBotToken}/getUpdates?offset=${_telegramOffset}&timeout=30`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.ok) {
        logger.debug(`Telegram getUpdates error: ${JSON.stringify(data)}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        _telegramOffset = update.update_id + 1;
        const msg = update.message;

        if (!msg || !msg.text) continue;

        // Only accept messages from the configured chat
        if (String(msg.chat.id) !== String(telegramChatId)) continue;

        // Try to parse as cookie
        const cookies = parseCookieFromMessage(msg.text);
        if (!cookies) continue;

        // Valid cookie found! Save it.
        logger.info('🍪 Cookie diterima via Telegram!');

        const state = {
          cookies,
          origins: [
            {
              origin: 'https://runway.edel.finance',
              localStorage: [],
            },
          ],
        };
        saveSessionRaw(state);

        const edelCookie = cookies.find((c) => c.name === 'edel_session');
        const tokenPreview = edelCookie
          ? `${edelCookie.value.substring(0, 20)}...`
          : 'N/A';

        logger.info(`✅ Session saved! Token: ${tokenPreview}`);
        logger.info(`   ${cookies.length} cookies imported`);

        // Send success notification
        await sendTelegram(
          [
            '✅ *SESSION UPDATED*',
            '',
            `🍪 Cookie berhasil di-import via Telegram!`,
            `📦 ${cookies.length} cookies saved`,
            '',
            '▶️ Bot akan melanjutkan voting...',
          ].join('\n')
        );

        // Delete the message containing the cookie (security)
        try {
          await fetch(`${TELEGRAM_API}${telegramBotToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramChatId,
              message_id: msg.message_id,
            }),
          });
          logger.debug('🗑️ Cookie message deleted for security.');
        } catch (e) {
          logger.debug(`Could not delete cookie message: ${e.message}`);
        }

        return true;
      }
    } catch (err) {
      logger.debug(`Telegram poll error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  logger.warn(`⏰ Timeout (${timeoutMinutes} min) waiting for cookie via Telegram.`);
  return false;
}
