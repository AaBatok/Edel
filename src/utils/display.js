/**
 * Terminal UI Display Module (Multi-Account)
 *
 * Header: EDEL BOT title + LIVE clock (counting forward).
 * Below header: per-account status rows with next vote countdown.
 * Below accounts: scrolling activity log.
 *
 * Uses ANSI escape codes for scroll regions.
 */

// ── ANSI helpers ────────────────────────────────
const ESC = '\x1b[';
const CLEAR = `${ESC}2J`;
const HOME = `${ESC}H`;
const SAVE_CURSOR = '\x1b7';
const RESTORE_CURSOR = '\x1b8';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

const moveTo = (row, col = 1) => `${ESC}${row};${col}H`;
const clearLine = () => `${ESC}2K`;
const setScrollRegion = (top, bottom) => `${ESC}${top};${bottom}r`;

// ── Colors (ANSI 256) ───────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  cyanBr:  '\x1b[96m',
  gray:    '\x1b[90m',
  green:   '\x1b[32m',
  greenBr: '\x1b[92m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  magentaBr: '\x1b[95m',
  red:     '\x1b[31m',
  white:   '\x1b[37m',
  whiteBr: '\x1b[97m',
  bgDark:  '\x1b[48;5;234m',
};

// ── State ───────────────────────────────────────
const BASE_HEADER_ROWS = 6; // Title + top bar + LIVE line + bottom bar + ACCOUNTS + ACTIVITY
let _headerRows = BASE_HEADER_ROWS;
let _isInteractive = false;
let _headerTimer = null;

// Per-account status: Map<accountId, { status, nextVote: Date|null, lastResult }>
const _accountStatus = new Map();

/**
 * Get current WIB time string
 */
function wibTime() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Format a Date as HH:mm WIB
 */
function formatTimeWIB(date) {
  if (!date) return '--:--';
  return date.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Calculate dynamic countdown string from now to target
 */
function countdown(targetDate) {
  if (!targetDate) return '';
  const diffMs = targetDate.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const diffMin = Math.ceil(diffMs / 60000);
  if (diffMin >= 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${diffMin}m`;
}

/**
 * Center a text within a given width
 */
function center(text, width) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - clean.length) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * Status emoji for account
 */
function statusEmoji(status) {
  const map = {
    voted: '✅',
    already_voted: '✅',
    waiting: '⏳',
    failed: '❌',
    expired: '🔑',
    running: '🔄',
    idle: '⬜',
  };
  return map[status] || '⬜';
}

/**
 * Draw the sticky header (rows 1–_headerRows)
 */
function drawHeader() {
  const w = Math.min(process.stdout.columns || 80, 100);
  const line = '═'.repeat(w);
  const thinLine = '─'.repeat(w);
  const time = wibTime();

  const rows = [
    `${C.magenta}${line}${C.reset}`,
    center(`${C.cyanBr}${C.bold}EDEL BOT${C.reset} ${C.dim}─${C.reset} ${C.gray}AUTO VOTE${C.reset}`, w),
    center(`${C.whiteBr}Created by Batokdrgn | HCA${C.reset}`, w),
    center(`${C.greenBr}LIVE${C.reset} ${C.dim}─${C.reset} ${C.whiteBr}${time} WIB${C.reset}`, w),
    `${C.magenta}${line}${C.reset}`,
  ];

  // Per-account status rows
  if (_accountStatus.size > 0) {
    // Column header
    rows.push(`${C.cyanBr}── ACCOUNTS (${_accountStatus.size}) ${C.cyan}${thinLine.substring(0, w - 18 - String(_accountStatus.size).length)}${C.reset}`);

    for (const [id, info] of _accountStatus) {
      const emoji = statusEmoji(info.status);
      const nextStr = info.nextVote ? `next ${formatTimeWIB(info.nextVote)}` : '';
      const cdStr = info.nextVote ? countdown(info.nextVote) : '';
      const cdPart = cdStr ? ` ${C.dim}(${cdStr})${C.reset}` : '';

      let statusText = '';
      if (info.status === 'running') {
        statusText = `${C.yellow}voting...${C.reset}`;
      } else if (info.status === 'expired') {
        statusText = `${C.red}session expired${C.reset}`;
      } else if (info.status === 'voted' || info.status === 'already_voted') {
        statusText = nextStr ? `${C.yellow}${nextStr}${C.reset}${cdPart}` : `${C.green}done${C.reset}`;
      } else if (info.status === 'waiting') {
        statusText = nextStr ? `${C.yellow}${nextStr}${C.reset}${cdPart}` : `${C.yellow}waiting${C.reset}`;
      } else if (info.status === 'failed') {
        statusText = nextStr ? `${C.yellow}${nextStr}${C.reset}${cdPart}` : `${C.red}failed${C.reset}`;
      } else {
        statusText = nextStr ? `${C.yellow}${nextStr}${C.reset}${cdPart}` : `${C.dim}idle${C.reset}`;
      }

      rows.push(`  ${emoji} ${C.whiteBr}${id}${C.reset} ${C.dim}│${C.reset} ${statusText}`);
    }
  }

  // Activity separator
  rows.push(`${C.magentaBr}── ACTIVITY ${C.magenta}${thinLine.substring(0, w - 13)}${C.reset}`);

  // Update header height
  _headerRows = rows.length;

  // Write header without disrupting the scroll region
  process.stdout.write(SAVE_CURSOR);
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(moveTo(i + 1) + clearLine() + rows[i]);
  }
  process.stdout.write(RESTORE_CURSOR);
}

/**
 * Recalculate scroll region (call when account count changes)
 */
function updateScrollRegion() {
  if (!_isInteractive) return;
  const totalRows = process.stdout.rows || 40;
  process.stdout.write(setScrollRegion(_headerRows + 1, totalRows));
  process.stdout.write(moveTo(_headerRows + 1));
}

/**
 * Initialize the TUI display.
 * Call this once at bot startup.
 */
export function initDisplay(opts = {}) {
  _isInteractive = process.stdout.isTTY === true;

  if (!_isInteractive) {
    // Not a terminal (PM2 log, pipe, etc.) — just print a simple banner
    console.log('');
    console.log('  ════════════════════════════════════════════════');
    console.log('         EDEL BOT - AUTO VOTE');
    console.log('       Created by Batokdrgn | HCA');
    console.log(`  LIVE - ${wibTime()} WIB`);
    console.log('  ════════════════════════════════════════════════');
    console.log('');
    return;
  }

  // Interactive terminal — set up scroll region
  const totalRows = process.stdout.rows || 40;

  process.stdout.write(CLEAR + HOME);
  drawHeader();
  process.stdout.write(setScrollRegion(_headerRows + 1, totalRows));
  process.stdout.write(moveTo(_headerRows + 1));

  // Refresh header every second (updates clock + countdowns dynamically)
  _headerTimer = setInterval(() => {
    drawHeader();
  }, 1000);

  // Handle terminal resize
  process.stdout.on('resize', () => {
    const newRows = process.stdout.rows || 40;
    process.stdout.write(setScrollRegion(_headerRows + 1, newRows));
    drawHeader();
  });

  // On exit, restore terminal
  const cleanup = () => {
    if (_headerTimer) clearInterval(_headerTimer);
    process.stdout.write(setScrollRegion(1, totalRows));
    process.stdout.write(SHOW_CURSOR);
  };
  process.on('exit', cleanup);
}

/**
 * Set accounts to display in the header.
 * Call this at startup with the list of accounts.
 *
 * @param {Array<{id: string}>} accounts
 */
export function setAccounts(accounts) {
  _accountStatus.clear();
  for (const acc of accounts) {
    _accountStatus.set(acc.id, { status: 'idle', nextVote: null, lastResult: null });
  }
  if (_isInteractive) {
    drawHeader();
    updateScrollRegion();
  }
}

/**
 * Update a single account's status in the header.
 *
 * @param {string} accountId - e.g. 'A1'
 * @param {object} info
 * @param {string} info.status - 'voted' | 'already_voted' | 'waiting' | 'failed' | 'expired' | 'running' | 'idle'
 * @param {Date|null} info.nextVote - Next vote time
 * @param {string} info.lastResult - Last result description
 */
export function updateAccountStatus(accountId, info = {}) {
  const existing = _accountStatus.get(accountId) || { status: 'idle', nextVote: null, lastResult: null };
  if (info.status !== undefined) existing.status = info.status;
  if (info.nextVote !== undefined) existing.nextVote = info.nextVote;
  if (info.lastResult !== undefined) existing.lastResult = info.lastResult;
  _accountStatus.set(accountId, existing);

  if (_isInteractive) {
    drawHeader();
  }
}

/**
 * Legacy updateStatus for backward compatibility (single-account mode).
 */
export function updateStatus(info = {}) {
  // If we have accounts, update the first one
  if (_accountStatus.size > 0) {
    const firstId = _accountStatus.keys().next().value;
    const nextVote = info.nextVote ? new Date() : null;
    updateAccountStatus(firstId, { status: info.status === 'LIVE' ? 'voted' : info.status, nextVote });
  }
}

/**
 * Cleanup display (call on shutdown)
 */
export function destroyDisplay() {
  if (_headerTimer) {
    clearInterval(_headerTimer);
    _headerTimer = null;
  }
  if (_isInteractive) {
    const totalRows = process.stdout.rows || 40;
    process.stdout.write(setScrollRegion(1, totalRows));
    process.stdout.write(SHOW_CURSOR);
  }
}

export default { initDisplay, setAccounts, updateAccountStatus, updateStatus, destroyDisplay };
