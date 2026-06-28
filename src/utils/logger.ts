import { env } from "@/config/env";

export const loggerConfig =
  env.NODE_ENV === "development"
    ? { level: "debug", transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: "info" };
