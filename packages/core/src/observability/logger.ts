import { pino, type Logger } from 'pino';

/** Field paths whose values are always redacted from logs (PII / credentials). */
export const redactPaths = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'email',
  'phone',
  'address',
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.cookie',
  '*.email',
  '*.phone',
  '*.address',
  'req.headers.authorization',
  'req.headers.cookie',
];

export interface LoggerOptions {
  level?: string;
  service: string;
  version?: string;
  environment?: string;
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { service: opts.service, version: opts.version, environment: opts.environment },
    redact: { paths: redactPaths, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type { Logger };
