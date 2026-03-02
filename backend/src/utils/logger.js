/**
 * Structured logger using pino.
 * In production, outputs JSON lines (machine-readable for Railway / Datadog).
 * In development, outputs coloured human-readable output via pino-pretty (if installed).
 */
const pino = require("pino");

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});

module.exports = logger;
