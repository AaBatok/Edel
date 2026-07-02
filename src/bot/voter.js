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

  // ── Find fixtures/decisions from ALL possible locations ──
  const candidateArrays = [
    data.preview?.options,
    data.options,
    data.decisions,
    data.fixtures,
    data.listingDecisions,
    data.round?.decisions,
    data.round?.fixtures,
    data.round?.options,
    data.round?.round?.decisions,
    data.round?.round?.fixtures,
    data.preview?.decisions,
    data.preview?.fixtures,
    data.currentWindow?.decisions,
    data.currentWindow?.fixtures,
  ];

  for (const arr of candidateArrays) {
    if (Array.isArray(arr) && arr.length > 0) {
      fixtures = arr;
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

  logger.debug(`📊 Parsed: status=${status}, roundId=${roundId?.substring(0, 30)}..., fixtures=${fixtures.length}, isPreview=${isPreview}`);

  return { status, roundId, fixtures, actions, stakeAmount, currentWindow, isPreview, raw: data };
}

/**
 * Extract fixture team IDs - handles different field names
 */
function getFixtureTeams(fixture) {
  return {
    id: fixture.listingDecisionId || fixture.id || fixture.roundDecisionId,
    teamAId: fixture.assetAId || fixture.teamAId || fixture.optionA?.assetId || fixture.optionA?.id,
    teamBId: fixture.assetBId || fixture.teamBId || fixture.optionB?.assetId || fixture.optionB?.id,
    selectedTeamId: fixture.selectedAssetId || fixture.selectedTeamId || null,
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
 */
export async function performVote() {
  const strategy = config.voteStrategy;
  logSeparator();
  logger.info(`🗳️  Starting vote | Strategy: ${strategy}`);

  try {
    // Step 1: Get current round
    logger.info('📡 Fetching current round...');
    let rawData = await getCurrentRound();
    let parsed = parseRoundData(rawData);

    if (!parsed) {
      return { success: false, details: { error: 'Empty API response', strategy } };
    }

    logger.info(`📊 Round status: ${formatStatus(parsed.status)}`);
    logger.info(`📋 Fixtures: ${parsed.fixtures.length}`);

    // Step 2: Already submitted?
    if (['SUBMITTED', 'SETTLEMENT_PENDING', 'SETTLED'].includes(parsed.status)) {
      logger.info('ℹ️  Already submitted for this round.');
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
      logger.info('⏳ Allocation pending. Calls not open yet.');
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
        logger.info(`⏳ Cannot start: ${reason}`);
        return {
          success: true,
          details: { asset: 'N/A', strategy, round: 'N/A', note: `Cannot start: ${reason}` },
        };
      }

      logger.info('🚀 Opening listing calls...');
      const startResult = await startRound();
      const startParsed = parseRoundData(startResult);
      logger.info(`✅ New round: ${formatStatus(startParsed?.status)}`);

      if (startParsed?.status === 'LOCKED' && startParsed.fixtures.length > 0) {
        // Wait for stake lock to complete before submitting
        logger.info('⏳ Waiting 5s for stake lock...');
        await sleep(5000);

        // Re-fetch fresh data after the wait (stake might have finalized)
        logger.info('📡 Re-fetching fresh round data...');
        rawData = await getCurrentRound();
        parsed = parseRoundData(rawData);

        if (parsed?.status === 'LOCKED' && parsed.fixtures.length > 0) {
          return doVoting(parsed, strategy);
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
      return doVoting(parsed, strategy);
    }

    // Unknown status
    logger.warn(`⚠️  Unknown status: ${parsed.status}`);
    return { success: false, details: { error: `Unknown status: ${parsed.status}`, strategy } };

  } catch (err) {
    const isSessionError = err.message.includes('SESSION_EXPIRED');
    logger.error(`${isSessionError ? '🔑' : '❌'} Vote failed: ${err.message}`);
    const details = { error: err.message, strategy, sessionExpired: isSessionError };
    logVote(false, details);
    return { success: false, details };
  }
}

/**
 * Actually perform voting on open fixtures.
 * Includes retry logic for transient submit errors (STAKE_LOCK_FAILED, INVALID_PICK).
 */
async function doVoting(parsed, strategy) {
  const MAX_SUBMIT_RETRIES = 3;

  // Load assets for display (once)
  let assetMap = new Map();
  try {
    const assets = await getAssets();
    assetMap = new Map(assets.map((a) => [a.id || a.assetId, a]));
  } catch (err) {
    logger.debug(`Could not load assets: ${err.message}`);
  }

  for (let submitAttempt = 1; submitAttempt <= MAX_SUBMIT_RETRIES; submitAttempt++) {
    const { roundId, fixtures, isPreview } = parsed;
    logger.info(`✅ Calls are OPEN! ${fixtures.length} head-to-head fixtures`);

    // Make selections for each fixture
    const picks = [];
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
        picks.push({ roundDecisionId: id, assetId: selectedTeamId });
        continue;
      }

      const selectedId = selectTeam(teamAId, teamBId, assetMap, strategy);
      picks.push({ roundDecisionId: id, assetId: selectedId });
    }

    if (picks.length === 0) {
      logger.warn('⚠️  No picks to submit.');
      return { success: false, details: { error: 'No valid fixtures to pick', strategy } };
    }

    // Submit picks
    logger.info(`📤 Submitting ${picks.length} picks (attempt ${submitAttempt}/${MAX_SUBMIT_RETRIES})...`);

    try {
      const result = await submitPicks(roundId, picks, { isPreview });
      const newParsed = parseRoundData(result);
      logger.info(`✅ Picks submitted! Status: ${formatStatus(newParsed?.status)}`);

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
      logger.warn(`⚠️  Submit attempt ${submitAttempt} failed: ${errMsg.substring(0, 200)}`);

      const isRetryable = errMsg.includes('STAKE_LOCK_FAILED')
        || errMsg.includes('INVALID_PICK')
        || errMsg.includes('502')
        || errMsg.includes('503')
        || errMsg.includes('504');

      if (!isRetryable || submitAttempt >= MAX_SUBMIT_RETRIES) {
        throw submitErr; // Let outer catch handle it
      }

      // Wait longer for STAKE_LOCK_FAILED (stake needs time)
      const waitSec = errMsg.includes('STAKE_LOCK_FAILED') ? 8 : 5;
      logger.info(`⏳ Waiting ${waitSec}s then re-fetching fresh data...`);
      await sleep(waitSec * 1000);

      // Re-fetch fresh round data to get updated preview/decisions
      try {
        const freshData = await getCurrentRound();
        const freshParsed = parseRoundData(freshData);

        if (freshParsed?.status === 'LOCKED' && freshParsed.fixtures.length > 0) {
          parsed = freshParsed; // Use fresh data for next attempt
          logger.info(`🔄 Got fresh data: ${freshParsed.fixtures.length} fixtures`);
        } else {
          logger.warn(`⚠️  Fresh data not ready: status=${formatStatus(freshParsed?.status)}, fixtures=${freshParsed?.fixtures?.length}`);
          throw submitErr;
        }
      } catch (fetchErr) {
        if (fetchErr === submitErr) throw submitErr;
        logger.warn(`⚠️  Re-fetch failed: ${fetchErr.message}`);
        throw submitErr;
      }
    }
  }

  return { success: false, details: { error: 'Submit retries exhausted', strategy } };
}
