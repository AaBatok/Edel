import fs from 'fs';
import path from 'path';
import config from '../utils/config.js';

const ROOT = config.rootDir;
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');

// ─── Helpers ────────────────────────────────────────────────────────

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Resolve relative sessionFile to absolute path when returning accounts.
 */
function resolveAccount(account) {
  return {
    ...account,
    sessionFile: path.isAbsolute(account.sessionFile)
      ? account.sessionFile
      : path.join(ROOT, account.sessionFile),
  };
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

function makeAccount(id) {
  return {
    id,
    sessionFile: `sessions/${id}.json`,
    enabled: true,
    lastVote: null,
    lastVoteStatus: null,
    nextVote: null,
  };
}

/**
 * Derive the next available account ID (A1, A2, A3, …).
 */
function nextAvailableId(accounts) {
  const taken = new Set(accounts.map((a) => a.id));
  let n = 1;
  while (taken.has(`A${n}`)) n++;
  return `A${n}`;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Return every account.
 */
export function getAccounts() {
  return loadAccounts().map(resolveAccount);
}

/**
 * Return only enabled accounts.
 */
export function getEnabledAccounts() {
  return loadAccounts().filter((a) => a.enabled).map(resolveAccount);
}

/**
 * Get a single account by id (e.g. 'A1').
 * Returns `undefined` when not found.
 */
export function getAccount(id) {
  const acc = loadAccounts().find((a) => a.id === id);
  return acc ? resolveAccount(acc) : undefined;
}

/**
 * Add a new account.
 * @param {string} [id] — e.g. 'A1'. Auto-generated when omitted.
 * @returns {object} the newly created account record.
 */
export function addAccount(id) {
  const accounts = loadAccounts();

  if (!id) {
    id = nextAvailableId(accounts);
  }

  if (accounts.some((a) => a.id === id)) {
    throw new Error(`Account "${id}" already exists`);
  }

  const account = makeAccount(id);
  accounts.push(account);
  saveAccounts(accounts);

  // Ensure sessions directory exists
  const sessionDir = path.join(ROOT, 'sessions');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  return account;
}

/**
 * Remove an account and optionally delete its session file.
 * @param {string} id
 * @param {boolean} [deleteSession=true]
 */
export function removeAccount(id, deleteSession = true) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`Account "${id}" not found`);

  const [removed] = accounts.splice(idx, 1);
  saveAccounts(accounts);

  if (deleteSession) {
    const absSession = path.join(ROOT, removed.sessionFile);
    if (fs.existsSync(absSession)) fs.unlinkSync(absSession);
  }

  return removed;
}

/**
 * Enable an account.
 */
export function enableAccount(id) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error(`Account "${id}" not found`);
  account.enabled = true;
  saveAccounts(accounts);
  return account;
}

/**
 * Disable an account.
 */
export function disableAccount(id) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error(`Account "${id}" not found`);
  account.enabled = false;
  saveAccounts(accounts);
  return account;
}

/**
 * Update vote-related status fields for an account.
 * @param {string} id
 * @param {{ lastVote?: string|null, lastVoteStatus?: string|null, nextVote?: string|null }} status
 */
export function updateAccountStatus(id, { lastVote, lastVoteStatus, nextVote } = {}) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error(`Account "${id}" not found`);

  if (lastVote !== undefined) account.lastVote = lastVote;
  if (lastVoteStatus !== undefined) account.lastVoteStatus = lastVoteStatus;
  if (nextVote !== undefined) account.nextVote = nextVote;

  saveAccounts(accounts);
  return account;
}

/**
 * Save cookies to the account's session file in Playwright-compatible format.
 * @param {string} id
 * @param {Array} cookies
 */
export function updateAccountSession(id, cookies) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new Error(`Account "${id}" not found`);

  const state = {
    cookies,
    origins: [
      {
        origin: 'https://runway.edel.finance',
        localStorage: [],
      },
    ],
  };

  const absPath = path.join(ROOT, account.sessionFile);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(absPath, JSON.stringify(state, null, 2), 'utf-8');
  return account;
}

/**
 * Total number of accounts.
 */
export function getAccountCount() {
  return loadAccounts().length;
}

/**
 * Migrate old single-account setup to multi-account.
 *
 * If `accounts.json` doesn't exist **and** the legacy `sessions/state.json`
 * exists, create the first account (A1) pointing at the copied session file.
 */
export function initDefaultAccount() {
  if (fs.existsSync(ACCOUNTS_FILE)) return; // already initialised

  const legacySession = path.join(ROOT, 'sessions', 'state.json');
  if (!fs.existsSync(legacySession)) return; // nothing to migrate

  const account = makeAccount('A1');
  const targetSession = path.join(ROOT, account.sessionFile);

  // Copy legacy session → A1 session
  fs.copyFileSync(legacySession, targetSession);

  saveAccounts([account]);
}
