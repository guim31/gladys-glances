// -----------------------------------------------------------------------------
// Failures that repeat at every read (Gladys away, /data not writable, a bug
// hit on each poll) would fill the logs of the Gladys supervisor: one line at
// the first failure, one when it heals, the repetitions in debug only
// (LOG_LEVEL=debug shows them).
// -----------------------------------------------------------------------------

/**
 * @param {object} logger a logger of the SDK (createLogger)
 */
export function createIssueLog(logger) {
  const failing = new Set();
  return {
    /** A failure: logged at `level` the first time, in debug while it lasts. */
    fail(key, level, ...args) {
      if (failing.has(key)) {
        logger.debug(...args);
        return;
      }
      failing.add(key);
      logger[level](...args);
    },
    /** A success: one info line if `key` was failing, nothing otherwise. */
    ok(key, message) {
      if (failing.delete(key)) {
        logger.info(message);
      }
    },
  };
}
