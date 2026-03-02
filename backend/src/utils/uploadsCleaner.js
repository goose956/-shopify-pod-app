/**
 * Periodically purge files from the uploads directory that are older than
 * MAX_UPLOAD_AGE_DAYS (default 7). Runs every 6 hours.
 */
const fs = require("fs");
const path = require("path");
const log = require("./logger");

const DEFAULT_MAX_AGE_DAYS = 7;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function startUploadsCleaner(uploadsDir) {
  const maxAgeDays = Number(process.env.MAX_UPLOAD_AGE_DAYS) || DEFAULT_MAX_AGE_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  function sweep() {
    try {
      if (!fs.existsSync(uploadsDir)) return;

      const now = Date.now();
      const files = fs.readdirSync(uploadsDir);
      let removed = 0;

      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            removed++;
          }
        } catch {
          // Skip files that can't be stat'd or deleted
        }
      }

      if (removed > 0) {
        log.info({ removed, maxAgeDays }, "Uploads cleanup completed");
      }
    } catch (err) {
      log.error({ err: err?.message }, "Uploads cleanup error");
    }
  }

  // Run once at startup (after a short delay)
  setTimeout(sweep, 30 * 1000);

  // Then every 6 hours
  const timer = setInterval(sweep, INTERVAL_MS);
  timer.unref(); // Don't prevent process from exiting

  log.info({ uploadsDir, maxAgeDays, intervalHours: INTERVAL_MS / 3600000 }, "Uploads cleaner scheduled");

  return timer;
}

module.exports = { startUploadsCleaner };
