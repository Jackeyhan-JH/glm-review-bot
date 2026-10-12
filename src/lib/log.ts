/**
 * 按行写 JSON 日志到 logsDir/glm-review.log（ts、level、msg、其余字段），
 * 可选同时输出到 stderr。完全可注入：文件、回显、时钟都可替换。
 */
import { appendFileSync } from 'node:fs';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** 日志文件路径；不传则不写文件。 */
  file?: string;
  /** true = 同时回显到 process.stderr；也可传入自定义回显函数。 */
  echo?: boolean | ((line: string) => void);
  /** 时间来源，默认系统时钟。 */
  clock?: Clock;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const clock: Clock = options.clock ?? systemClock;
  const echoFn =
    options.echo === undefined || options.echo === false
      ? undefined
      : typeof options.echo === 'function'
        ? options.echo
        : (line: string) => process.stderr.write(`${line}\n`);
  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    const line = JSON.stringify({ ...fields, ts: clock.now().toISOString(), level, msg });
    if (options.file !== undefined) appendFileSync(options.file, `${line}\n`);
    if (echoFn !== undefined) echoFn(line);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/** 什么都不做的空日志器，测试用。 */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
