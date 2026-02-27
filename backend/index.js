const { createServer } = require("./src/server");

// Catch unhandled promise rejections so the process doesn't crash silently
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  process.exit(1);
});

(async () => {
  const { app, server } = await createServer();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  function shutdown(signal) {
    console.log(`[Shutdown] ${signal} received — closing server…`);
    server.close(() => {
      console.log("[Shutdown] HTTP server closed");
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
      console.error("[Shutdown] Forced exit after timeout");
      process.exit(1);
    }, 10000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
