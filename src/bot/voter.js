/**
 * Core voting engine — pure HTTP, no browser needed.
 *
 * Updated for Preview Listing Round API (July 2026).
 *
 * Flow:
 *   1. GET /listing-round → check round/preview status & fixtures
 *   2. If no round → POST /listing-round (open listing calls) → wait for stake lock
 *   3. If status is LOCKED → pick assets
 *   4. POST /listing-round/submit → submit all selections
 *
 * Handles both Preview API (new) and Legacy API (old) response formats.
 */
import config from '../utils/config.js';
import logger, { logVote, logSeparator } from '../utils/logger.js';
import { getCurrentRound, startRound, submitPicks, getAssets } from '../api/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deep-search for a key in a nested object.
 */
function findKey(obj, key, maxDepth = 5) {
  if (!obj || typeof obj !== 'object' || maxDepth <= 0) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Extract round info from the API response, regardless of nesting.
 */
function parseRoundData(data) {
  if (!data) return null;

  const keys = Object.keys(data);
  logger.debug(`📦 API keys: [${keys.join(', ')}]`);

  let status = null;
  let roundId = null;
  let fixtures = null;
  let actions = null;
  let stakeAmount = null;
  let isPreview = false;

  // ── Detect status from round object ──────────
  if (data.round) {
    if (data.round.status && typeof data.round.status === 'string') {
      status = data.round.status;
      roundId = data.round.id || data.round.roundId;
      stakeAmount = data.round.stakeAmount;
    } else if (data.round.round && typeof data.round.round === 'object') {
      status = data.round.round.status;
      roundId = data.round.round.id || data.round.round.roundId;
      stakeAmount = data.round.round.stakeAmount;
    }
  }

  // ── Detect preview ──────────────────────────
  if (data.preview) {
    isPreview = true;
    // For preview submit, we MUST use preview.id as the previewId
    roundId = data.preview.id;
    if (!status) status = 'LOCKED'; // preview = selections open
    if (!stakeAmount) stakeAmount = data.preview.stakeAmount;
  }

  // ── Status from top-level ──────────────────
  if (!status && data.status && typeof data.status === 'string') {
    status = data.status;
  }
  if (!roundId) {
    roundId = data.roundId || data.id || findKey(data, 'roundId');
  }

  // ── Find fixtures/decisions ──
  // CRITICAL: When isPreview=true (preview submit API), we MUST use
  // preview.options because its listingDecisionId matches the previewId scope.
  // Using round.decisions (with decisionId) causes INVALID_PICK because those
  // IDs belong to a different scope!
  // When NOT preview, round.decisions comes first for legacy API.
  const candidateArrays = isPreview
    ? [
        // Preview-first: IDs match previewId scope
        data.preview?.options,
        data.preview?.decisions,
        data.preview?.fixtures,
        // Fallback to round if preview has no data
        data.round?.decisions,
        data.round?.fixtures,
        data.round?.options,
        data.round?.round?.decisions,
        data.round?.round?.fixtures,
        // Top-level
        data.decisions,
        data.fixtures,
        data.options,
        data.currentWindow?.decisions,
        data.currentWindow?.fixtures,
      ]
    : [
        // Round-first: for legacy API
        data.round?.decisions,
        data.round?.fixtures,
        data.round?.options,
        data.round?.round?.decisions,
        data.round?.round?.fixtures,
        data.preview?.options,
        data.preview?.decisions,
        data.preview?.fixtures,
        data.decisions,
        data.fixtures,
        data.options,
        data.currentWindow?.decisions,
        data.currentWindow?.fixtures,
      ];

  let fixtureSource = 'unknown';
  const candidateNames = isPreview
    ? [
        'preview.options', 'preview.decisions', 'preview.fixtures',
        'round.decisions', 'round.fixtures', 'round.options',
        'round.round.decisions', 'round.round.fixtures',
        'data.decisions', 'data.fixtures', 'data.options',
        'currentWindow.decisions', 'currentWindow.fixtures',
      ]
    : [
        'round.decisions', 'round.fixtures', 'round.options',
        'round.round.decisions', 'round.round.fixtures',
        'preview.options', 'preview.decisions', 'preview.fixtures',
        'data.decisions', 'data.fixtures', 'data.options',
        'currentWindow.decisions', 'currentWindow.fixtures',
      ];

  for (let ci = 0; ci < candidateArrays.length; ci++) {
    const arr = candidateArrays[ci];
    if (Array.isArray(arr) && arr.length > 0) {
      fixtures = arr;
      fixtureSource = candidateNames[ci] || `index-${ci}`;
      break;
    }
  }

  // Last resort: deep search
  if (!fixtures || fixtures.length === 0) {
    const deep = findKey(data, 'decisions', 4) || findKey(data, 'fixtures', 4) || findKey(data, 'options', 4);
    fixtures = Array.isArray(deep) ? deep : [];
  }

  if (!Array.isArray(fixtures)) fixtures = [];

  // ── Actions ──
  actions = data.actions || data.round?.actions || {};
  if (actions.prepareRound && !actions.startRound) {
    actions.startRound = actions.prepareRound;
  }

  const currentWindow = data.currentWindow || data.round?.currentWindow || null;

  logger.info(`📊 Parsed: status=${status}, roundId=${roundId?.substring(0, 40)}..., fixtures=${fixtures.length} (from: ${fixtureSource}), isPreview=${isPreview}`);

  // Log fixture ID fields for debugging
  if (fixtures.length > 0) {
    const f0 = fixtures[0];
    logger.info(`📋 First fixture keys: [${Object.keys(f0).join(', ')}]`);
    logger.info(`📋 First fixture IDs: id=${f0.id}, decisionId=${f0.decisionId}, listingDecisionId=${f0.listingDecisionId}`);
  }

  return { status, roundId, fixtures, actions, stakeAmount, currentWindow, isPreview, raw: data };
}

/**
 * Extract fixture team IDs - handles different field names
 */
function getFixtureTeams(fixture) {
  return {
    // listingDecisionId (from preview.options) matches the previewId scope for submit.
    // decisionId (from round.decisions) is fallback for legacy API.
    id: fixture.listingDecisionId || fixture.decisionId || fixture.id || fixture.roundDecisionId,
    teamAId: fixture.assetAId || fixture.teamAId || fixture.optionA?.assetId || fixture.optionA?.id,
    teamBId: fixture.assetBId || fixture.teamBId || fixture.optionB?.assetId || fixture.optionB?.id,
    selectedTeamId: fixture.pickedAssetId || fixture.selectedAssetId || fixture.selectedTeamId || null,
  };
}

/**
 * Select which team to pick for a fixture based on strategy
 */
function selectTeam(teamAId, teamBId, assetMap, strategy) {
  const a = assetMap.get(teamAId);
  const b = assetMap.get(teamBId);

  switch (strategy) {
    case 'first':
      return teamAId;
    case 'second':
      return teamBId;
    case 'smart':
    case 'random':
    default: {
      const pick = Math.random() < 0.5 ? teamAId : teamBId;
      const picked = assetMap.get(pick);
      logger.info(`   🎯 ${a?.ticker || 'A'} vs ${b?.ticker || 'B'} → ${picked?.ticker || pick}`);
      return pick;
    }
  }
}

/**
 * Format listing call status for display
 */
function formatStatus(status) {
  const map = {
    CREATED: 'Created',
    LOCK_PENDING: 'Allocation Pending',
    LOCKED: 'Calls Open ✅',
    SUBMITTED: 'Selections Submitted',
    SETTLEMENT_PENDING: 'Demand Index Pending',
    SETTLED: 'Demand Index Final',
    EXPIRED: 'Window Closed',
    FAILED: 'Review Required',
  };
  return map[status] || status || 'unknown';
}

/**
 * Main voting function — pure HTTP, no browser
 * @param {object} account - Account context { id, sessionFile }
 */
export async function performVote(account = {}) {
  const strategy = config.voteStrategy;
  const sf = account.sessionFile || undefined;
  const tag = account.id ? `[${account.id}] ` : '';
  logSeparator();
  logger.info(`${tag}🗳️  Starting vote | Strategy: ${strategy}`);

  try {
    // Step 1: Get current round
    logger.info(`${tag}📡 Fetching current round...`);
    let rawData = await getCurrentRound(sf);
    let parsed = parseRoundData(rawData);

    if (!parsed) {
      return { success: false, details: { error: 'Empty API response', strategy } };
    }

    logger.info(`${tag}📊 Round status: ${formatStatus(parsed.status)}`);
    logger.info(`${tag}📋 Fixtures: ${parsed.fixtures.length}`);

    // Step 2: Already submitted?
    if (['SUBMITTED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(parsed.status)) {
      logger.info(`${tag}ℹ️  Already submitted for this round.`);
      return {
        success: true,
        details: {
          asset: 'N/A', strategy, round: parsed.roundId,
          note: `Already submitted (${formatStatus(parsed.status)})`,
        },
      };
    }

    // Step 3: Calls not open yet?
    if (['CREATED', 'LOCK_PENDING'].includes(parsed.status)) {
      logger.info(`${tag}⏳ Allocation pending. Calls not open yet.`);
      return {
        success: true,
        details: {
          asset: 'N/A', strategy, round: parsed.roundId,
          note: `Waiting (${formatStatus(parsed.status)})`,
        },
      };
    }

    // Step 4: Need to start/open listing calls?
    if (['EXPIRED', 'FAILED'].includes(parsed.status) || !parsed.status) {
      const startAction = parsed.actions?.startRound || parsed.actions?.prepareRound;
      if (startAction?.enabled === false) {
        const reason = startAction?.reason || 'Action not available';
        logger.info(`${tag}⏳ Cannot start: ${reason}`);
        return {
          success: true,
          details: { asset: 'N/A', strategy, round: 'N/A', note: `Cannot start: ${reason}` },
        };
      }

      logger.info(`${tag}🚀 Opening listing calls...`);
      const startResult = await startRound(sf);
      const startParsed = parseRoundData(startResult);
      logger.info(`${tag}✅ New round: ${formatStatus(startParsed?.status)}`);

      if (startParsed?.status === 'LOCKED' && startParsed.fixtures.length > 0) {
        // Wait for stake lock to complete before submitting
        logger.info(`${tag}⏳ Waiting 5s for stake lock...`);
        await sleep(5000);

        // Re-fetch fresh data after the wait
        logger.info(`${tag}📡 Re-fetching fresh round data...`);
        rawData = await getCurrentRound(sf);
        parsed = parseRoundData(rawData);

        if (parsed?.status === 'LOCKED' && parsed.fixtures.length > 0) {
          return doVoting(parsed, strategy, sf, tag);
        }
      }

      // Not ready yet — will retry on next cycle
      return {
        success: true,
        details: {
          asset: 'N/A', strategy, round: startParsed?.roundId,
          note: `Round opened (${formatStatus(startParsed?.status)}). Will vote when ready.`,
        },
      };
    }

    // Step 5: LOCKED = selections are open!
    if (parsed.status === 'LOCKED') {
      return doVoting(parsed, strategy, sf, tag);
    }

    // Unknown status
    logger.warn(`${tag}⚠️  Unknown status: ${parsed.status}`);
    return { success: false, details: { error: `Unknown status: ${parsed.status}`, strategy } };

  } catch (err) {
    const isSessionError = err.message.includes('SESSION_EXPIRED');
    logger.error(`${tag}${isSessionError ? '🔑' : '❌'} Vote failed: ${err.message}`);
    const details = { error: err.message, strategy, sessionExpired: isSessionError };
    logVote(false, details);
    return { success: false, details };
  }
}

/**
 * Actually perform voting on open fixtures.
 * Includes retry logic for transient submit errors (STAKE_LOCK_FAILED, INVALID_PICK).
 */
async function doVoting(parsed, strategy, sessionFile, tag = '') {
  const MAX_SUBMIT_RETRIES = 5;

  // Load assets for display (once)
  let assetMap = new Map();
  try {
    const assets = await getAssets(sessionFile);
    assetMap = new Map(assets.map((a) => [a.id || a.assetId, a]));
  } catch (err) {
    logger.debug(`Could not load assets: ${err.message}`);
  }

  /**
   * Build picks from parsed round data
   */
  function buildPicks(roundParsed) {
    const { fixtures } = roundParsed;
    const newPicks = [];
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i];
      const { id, teamAId, teamBId, selectedTeamId } = getFixtureTeams(fixture);

      if (!teamAId || !teamBId) {
        logger.debug(`   ${i + 1}. Skipping (missing teams): ${JSON.stringify(fixture).substring(0, 150)}`);
        continue;
      }

      if (selectedTeamId) {
        const selected = assetMap.get(selectedTeamId);
        logger.info(`   ${i + 1}. Already picked: ${selected?.ticker || selectedTeamId}`);
        newPicks.push({ roundDecisionId: id, assetId: selectedTeamId });
        continue;
      }

      const selectedId = selectTeam(teamAId, teamBId, assetMap, strategy);
      newPicks.push({ roundDecisionId: id, assetId: selectedId });
    }
    return newPicks;
  }

  // Build initial picks
  let { roundId, fixtures, isPreview } = parsed;
  logger.info(`${tag}✅ Calls are OPEN! ${fixtures.length} head-to-head fixtures`);
  let picks = buildPicks(parsed);

  if (picks.length === 0) {
    logger.warn(`${tag}⚠️  No picks to submit.`);
    return { success: false, details: { error: 'No valid fixtures to pick', strategy } };
  }

  // Submit picks — retry with SAME payload on STAKE_LOCK_FAILED
  // On INVALID_PICK: start fresh round → rebuild picks → retry
  for (let submitAttempt = 1; submitAttempt <= MAX_SUBMIT_RETRIES; submitAttempt++) {
    logger.info(`${tag}📤 Submitting ${picks.length} picks (attempt ${submitAttempt}/${MAX_SUBMIT_RETRIES})...`);
    logger.info(`${tag}📤 previewId: ${roundId}`);
    logger.info(`${tag}📤 isPreview: ${isPreview}`);

    try {
      const result = await submitPicks(roundId, picks, { isPreview }, sessionFile);
      const newParsed = parseRoundData(result);
      logger.info(`${tag}✅ Picks submitted! Status: ${formatStatus(newParsed?.status)}`);

      const pickedAssets = picks
        .map((p) => assetMap.get(p.assetId)?.ticker || 'unknown')
        .join(', ');

      const details = {
        asset: pickedAssets,
        strategy,
        round: roundId,
        fixtureCount: fixtures.length,
      };

      logVote(true, details);
      return { success: true, details };

    } catch (submitErr) {
      const errMsg = submitErr.message;
      logger.warn(`${tag}⚠️  Submit attempt ${submitAttempt} failed: ${errMsg.substring(0, 200)}`);

      const isStakeLock = errMsg.includes('STAKE_LOCK_FAILED');
      const isInvalidPick = errMsg.includes('INVALID_PICK');

      // INVALID_PICK = stale preview data → start fresh round to get new preview
      if (isInvalidPick && submitAttempt < MAX_SUBMIT_RETRIES) {
        logger.info(`${tag}🔄 INVALID_PICK: refreshing calls (starting new round)...`);
        try {
          const freshStart = await startRound(sessionFile);
          const freshParsed = parseRoundData(freshStart);

          if (freshParsed?.status === 'LOCKED' && freshParsed.fixtures.length > 0) {
            // Wait for stake lock
            logger.info(`${tag}⏳ Waiting 8s for stake lock...`);
            await sleep(8000);

            // Re-fetch after wait
            const freshData = await getCurrentRound(sessionFile);
            const reParsed = parseRoundData(freshData);

            if (reParsed?.status === 'LOCKED' && reParsed.fixtures.length > 0) {
              // Rebuild picks with FRESH data
              roundId = reParsed.roundId;
              fixtures = reParsed.fixtures;
              isPreview = reParsed.isPreview;
              picks = buildPicks(reParsed);
              logger.info(`${tag}🔄 Got fresh preview: ${roundId?.substring(0, 50)}..., ${fixtures.length} fixtures`);
              continue; // retry submit with new data
            }
          }

          logger.warn(`${tag}⚠️  Fresh round not ready: ${formatStatus(freshParsed?.status)}`);
        } catch (refreshErr) {
          logger.warn(`${tag}⚠️  Refresh failed: ${refreshErr.message.substring(0, 150)}`);
        }
        // Wait and try again
        await sleep(5000);
        continue;
      }

      const isRetryable = isStakeLock
        || errMsg.includes('502')
        || errMsg.includes('503')
        || errMsg.includes('504');

      if (!isRetryable || submitAttempt >= MAX_SUBMIT_RETRIES) {
        throw submitErr; // Let outer catch handle it
      }

      // STAKE_LOCK_FAILED: just wait and retry SAME payload.
      const waitSec = isStakeLock ? 10 : 5;
      logger.info(`${tag}⏳ Waiting ${waitSec}s before retry (same payload)...`);
      await sleep(waitSec * 1000);
    }
  }

  return { success: false, details: { error: 'Submit retries exhausted', strategy } };
}
