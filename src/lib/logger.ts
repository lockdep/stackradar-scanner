import pino from "pino";

const pretty = process.env.LOG_PRETTY === "true";

export const log = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: {
        service: "stack-radar-scanner",
        env: process.env.NODE_ENV ?? "development",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
    ...(pretty && {
        transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
    }),
});
