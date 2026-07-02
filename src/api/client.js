/**
 * HTTP API client for Edel Runway Desk.
 *
 * All endpoints are relative to https://runway.edel.finance
 * Auth is handled via the `edel_session` cookie (credentials: include).
 *
 * Updated for Preview Listing Round API (June 2026):
 *   GET  /listing/status          → listing system status
 *   GET  /listing-round           → current round + preview data
 *   POST /listing-round           → prepare/start a new round
 *   POST /listing-round/submit    → submit selections
 *   GET  /assets                  → all assets
 *   GET  /demand-index            → demand index rankings
 *   GET  /balances                → user balances
 */
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { loadSession } from '../auth/session.js';

const BASE_URL = config.baseUrl; // https://runway.edel.finance

/**
 * Build Cookie header string from saved session cookies
 * @param {string} [sessionFile] - Optional session file path
 */
function buildCookieHeader(sessionFile) {
  const session = loadSession(sessionFile);
  if (!session || !session.cookies || session.cookies.length === 0) {
    return null;
  }

  return session.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Make an authenticated API request
 * @param {string} path - API path
 * @param {object} [options] - Fetch options + optional sessionFile
 * @param {string} [options.sessionFile] - Optional session file path
 */
async function apiFetch(path, options = {}) {
  const { sessionFile, ...fetchOptions } = options;
  const cookie = buildCookieHeader(sessionFile);
  if (!cookie) {
    throw new Error('No session cookies found. Run: npm run import');
  }

  const url = `${BASE_URL}${path}`;
  const method = fetchOptions.method || 'GET';

  const headers = {
    accept: 'application/json',
    cookie,
    ...fetchOptions.headers,
  };

  // Add content-type for POST/PUT/PATCH
  if (fetchOptions.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  logger.debug(`📡 ${method} ${path}`);

  const res = await fetch(url, {
    method,
    headers,
    body: fetchOptions.body,
  });

  // Check for auth redirect (session expired)
  if (res.status === 401 || res.status === 403) {
    throw new Error('SESSION_EXPIRED: Cookie tidak valid lagi. Run: npm run import');
  }

  // Check for redirects to login
  if (res.redirected && (res.url.includes('/login') || res.url.includes('/register'))) {
    throw new Error('SESSION_EXPIRED: Redirected ke login. Run: npm run import');
  }

  return res;
}

/**
 * GET request with JSON response
 * @param {string} path - API path
 * @param {string} [sessionFile] - Optional session file path
 */
async function apiGet(path, sessionFile) {
  const res = await apiFetch(path, { sessionFile });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API Error ${res.status} GET ${path}: ${body.substring(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * POST request with JSON body and response
 * @param {string} path - API path
 * @param {object} [body] - Request body
 * @param {string} [sessionFile] - Optional session file path
 */
async function apiPost(path, body = {}, sessionFile) {
  const res = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    sessionFile,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API Error ${res.status} POST ${path}: ${text.substring(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ═══════════════════════════════════════════
//  PUBLIC API FUNCTIONS
// ═══════════════════════════════════════════

/**
 * Get all available assets/teams
 * GET /assets
 */
export async function getAssets(sessionFile) {
  const data = await apiGet('/assets', sessionFile);
  return data.assets || [];
}

/**
 * Get listing system status
 * GET /listing/status
 */
export async function getListingStatus(sessionFile) {
  return apiGet('/listing/status', sessionFile);
}

/**
 * Get current listing round (Preview API)
 * GET /listing-round
 *
 * Returns preview-format round data with:
 *   - round or preview object
 *   - actions (prepareRound, submitPreview, etc.)
 *   - currentWindow
 */
export async function getCurrentRound(sessionFile) {
  // Try preview API first (new)
  try {
    const data = await apiGet('/listing-round', sessionFile);
    return data;
  } catch (err) {
    // If preview API fails, try legacy endpoint as fallback
    if (err.message.includes('404') || err.message.includes('ROUTE_NOT_FOUND')) {
      logger.debug('Preview API failed, trying legacy /listing-rounds/current...');
      return apiGet('/listing-rounds/current', sessionFile);
    }
    throw err;
  }
}

/**
 * Start/prepare a new listing round (Preview API)
 * POST /listing-round
 */
export async function startRound(sessionFile) {
  try {
    return await apiPost('/listing-round', {}, sessionFile);
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('ROUTE_NOT_FOUND')) {
      logger.debug('Preview start failed, trying legacy /listing-rounds/start...');
      return apiPost('/listing-rounds/start', {}, sessionFile);
    }
    throw err;
  }
}

/**
 * Submit picks/selections (Preview API)
 * POST /listing-round/submit
 *
 * Preview API format:
 *   { previewId: string, picks: [{listingDecisionId, assetId}] }
 *
 * Legacy API format:
 *   POST /listing-rounds/{roundId}/picks
 *   { picks: [{roundDecisionId, assetId}] }
 *
 * @param {string} roundId - Round ID or preview ID
 * @param {Array} picks - Array of pick objects
 * @param {object} opts
 * @param {boolean} opts.isPreview - Whether to use preview API
 */
export async function submitPicks(roundId, picks, { isPreview = false } = {}, sessionFile) {
  if (isPreview) {
    // Preview API: POST /listing-round/submit
    return apiPost('/listing-round/submit', {
      previewId: roundId,
      picks: picks.map((p) => ({
        listingDecisionId: p.roundDecisionId || p.listingDecisionId,
        assetId: p.assetId,
      })),
    }, sessionFile);
  }

  // Legacy API: POST /listing-rounds/{roundId}/picks
  return apiPost(`/listing-rounds/${roundId}/picks`, { picks }, sessionFile);
}

/**
 * Get demand index / league table
 * GET /demand-index
 */
export async function getDemandIndex(sessionFile) {
  return apiGet('/demand-index', sessionFile);
}

/**
 * Get balance for an instrument
 * GET /balances?instrumentId=xxx
 */
export async function getBalance(instrumentId, sessionFile) {
  const params = instrumentId ? `?instrumentId=${instrumentId}` : '';
  return apiGet(`/balances${params}`, sessionFile);
}

/**
 * Check if the session is valid by calling the API
 * Returns true if authenticated, false if expired
 */
export async function checkSession(sessionFile) {
  try {
    await apiGet('/listing/status', sessionFile);
    return true;
  } catch (err) {
    if (err.message.includes('SESSION_EXPIRED')) return false;
    // Try a lightweight endpoint
    try {
      await apiGet('/profile', sessionFile);
      return true;
    } catch {
      return false;
    }
  }
}
