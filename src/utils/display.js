/**
 * Terminal UI Display Module
 *
 * Provides a sticky header at the top of the terminal
 * with a scrolling activity/log region below it.
 *
 * Uses ANSI escape codes for scroll regions so the
 * header never scrolls away when logs pile up.
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
const HEADER_ROWS = 7; // Lines reserved for the header
let _status = 'STARTING';
let _nextVote = '--:--';
let _nextVoteCountdown = '';
let _strategy = 'smart';
let _interval = '65';
let _isInteractive = false;
let _headerTimer = null;

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
 * Center a text within a given width
 */
function center(text, width) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for length calc
  const pad = Math.max(0, Math.floor((width - clean.length) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * Draw the sticky header (rows 1–HEADER_ROWS)
 */
function drawHeader() {
  const w = Math.min(process.stdout.columns || 80, 100);
  const line = '═'.repeat(w);
  const thinLine = '─'.repeat(w);
  const time = wibTime();

  // Build status line
  let statusLine = `${C.greenBr}LIVE${C.reset} ${C.dim}─${C.reset} ${C.whiteBr}${time} WIB${C.reset}`;
  if (_nextVote !== '--:--') {
    statusLine += ` ${C.dim}─${C.reset} ${C.yellow}next ${_nextVote} WIB${C.reset}`;
    if (_nextVoteCountdown) {
      statusLine += ` ${C.dim}(${_nextVoteCountdown})${C.reset}`;
    }
  }

  const rows = [
    `${C.magenta}${line}${C.reset}`,
    center(`${C.cyanBr}${C.bold}EDEL BOT${C.reset} ${C.dim}─${C.reset} ${C.whiteBr}AUTO VOTE${C.reset}`, w),
    center(`${C.gray}Created by Batokdrgn | HCA${C.reset}`, w),
    center(statusLine, w),
    `${C.magenta}${line}${C.reset}`,
    `${C.magentaBr}── ACTIVITY ${C.magenta}${thinLine.substring(0, w - 13)}${C.reset}`,
  ];

  // Write header without disrupting the scroll region
  process.stdout.write(SAVE_CURSOR);
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(moveTo(i + 1) + clearLine() + rows[i]);
  }
  process.stdout.write(RESTORE_CURSOR);
}

/**
 * Initialize the TUI display.
 * Call this once at bot startup.
 */
export function initDisplay(opts = {}) {
  _strategy = opts.strategy || 'smart';
  _interval = opts.interval || '65';
  _isInteractive = process.stdout.isTTY === true;

  if (!_isInteractive) {
    // Not a terminal (PM2 log, pipe, etc.) — just print a simple banner
    console.log('');
    console.log('  ════════════════════════════════════════════════');
    console.log('         EDEL BOT - AUTO VOTE');
    console.log('       Created by Batokdrgn | HCA');
    console.log(`  LIVE - ${wibTime()} WIB`);
    console.log('  ════════════════════════════════════════════════');
    console.log('  ── ACTIVITY ─────────────────────────────────');
    console.log('');
    return;
  }

  // Interactive terminal — set up scroll region
  const totalRows = process.stdout.rows || 40;

  process.stdout.write(CLEAR + HOME);    // clear screen
  drawHeader();
  // Set scroll region: only rows below header scroll
  process.stdout.write(setScrollRegion(HEADER_ROWS + 1, totalRows));
  // Move cursor to first line of scroll region
  process.stdout.write(moveTo(HEADER_ROWS + 1));

  // Refresh header every second (updates the clock)
  _headerTimer = setInterval(() => {
    drawHeader();
  }, 1000);

  // Handle terminal resize
  process.stdout.on('resize', () => {
    const newRows = process.stdout.rows || 40;
    process.stdout.write(setScrollRegion(HEADER_ROWS + 1, newRows));
    drawHeader();
  });

  // On exit, restore terminal
  const cleanup = () => {
    if (_headerTimer) clearInterval(_headerTimer);
    process.stdout.write(setScrollRegion(1, totalRows)); // reset scroll region
    process.stdout.write(SHOW_CURSOR);
  };
  process.on('exit', cleanup);
}

/**
 * Update the header status info.
 * Call this after scheduling the next vote.
 *
 * @param {object} info
 * @param {string} info.status     - "LIVE" | "EXPIRED" | "STOPPED"
 * @param {string} info.nextVote   - Next vote time "HH:mm" WIB
 * @param {string} info.countdown  - e.g. "62m lagi"
 */
export function updateStatus(info = {}) {
  if (info.status) _status = info.status;
  if (info.nextVote) _nextVote = info.nextVote;
  if (info.countdown) _nextVoteCountdown = info.countdown;

  if (_isInteractive) {
    drawHeader();
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

export default { initDisplay, updateStatus, destroyDisplay };
