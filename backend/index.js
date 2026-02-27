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
  const port = Number(process.env.PORT || 3000);
  const app = await createServer();

  app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
  });
})();
