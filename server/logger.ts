/**
 * Centralized Logging Module for Claude-Call
 *
 * Features:
 * - Log levels: DEBUG, INFO, WARN, ERROR, FATAL
 * - Dual output: Console + File
 * - Log rotation: Size-based (configurable max size and history count)
 * - Environment variable configuration
 *
 * Environment Variables:
 * - LOG_LEVEL: Minimum log level (default: INFO)
 * - LOG_DIR: Directory for log files (default: ./logs)
 * - LOG_MAX_SIZE: Max file size in bytes before rotation (default: 10MB)
 * - LOG_MAX_FILES: Number of rotated files to keep (default: 5)
 */

import { mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { appendFileSync } from "node:fs";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO ",
  [LogLevel.WARN]: "WARN ",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.FATAL]: "FATAL",
};

interface LoggerConfig {
  level: LogLevel;
  logDir: string;
  maxSize: number;
  maxFiles: number;
  filename: string;
  consoleOutput: boolean;
}

/**
 * Parse log level from string
 */
function parseLogLevel(level: string | undefined): LogLevel {
  if (!level) return LogLevel.INFO;
  const upper = level.toUpperCase();
  switch (upper) {
    case "DEBUG": return LogLevel.DEBUG;
    case "INFO": return LogLevel.INFO;
    case "WARN": return LogLevel.WARN;
    case "ERROR": return LogLevel.ERROR;
    case "FATAL": return LogLevel.FATAL;
    default: return LogLevel.INFO;
  }
}

/**
 * Parse size string (e.g., "10MB", "1024") to bytes
 */
function parseSize(size: string | undefined, defaultBytes: number): number {
  if (!size) return defaultBytes;
  const match = size.match(/^(\d+)(KB|MB|GB)?$/i);
  if (!match) return defaultBytes;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || "").toUpperCase();
  switch (unit) {
    case "KB": return num * 1024;
    case "MB": return num * 1024 * 1024;
    case "GB": return num * 1024 * 1024 * 1024;
    default: return num;
  }
}

export class Logger {
  private config: LoggerConfig;
  private logFilePath: string;

  constructor(
    component: string,
    options: Partial<LoggerConfig> = {}
  ) {
    this.config = {
      level: options.level ?? parseLogLevel(process.env.LOG_LEVEL),
      logDir: options.logDir ?? process.env.LOG_DIR ?? "./logs",
      maxSize: options.maxSize ?? parseSize(process.env.LOG_MAX_SIZE, 10 * 1024 * 1024),
      maxFiles: options.maxFiles ?? parseInt(process.env.LOG_MAX_FILES || "5", 10),
      filename: options.filename ?? "claude-call.log",
      consoleOutput: options.consoleOutput ?? true,
    };

    // Ensure log directory exists
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }

    this.logFilePath = `${this.config.logDir}/${this.config.filename}`;
  }

  /**
   * Format log message with timestamp, level, and component
   */
  private formatMessage(level: LogLevel, component: string, message: string, meta?: object): string {
    const timestamp = new Date().toISOString();
    const levelName = LOG_LEVEL_NAMES[level];
    let formatted = `[${timestamp}] [${levelName}] [${component}] ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      formatted += ` ${JSON.stringify(meta)}`;
    }
    return formatted;
  }

  /**
   * Check if rotation is needed and perform rotation
   */
  private checkRotation(): void {
    if (!existsSync(this.logFilePath)) {
      return;
    }

    try {
      const stats = statSync(this.logFilePath);
      if (stats.size >= this.config.maxSize) {
        this.rotateFiles();
      }
    } catch {
      // Ignore errors during rotation check
    }
  }

  /**
   * Rotate log files: current -> .1 -> .2 -> ... -> delete oldest
   */
  private rotateFiles(): void {
    try {
      // Delete oldest file if it exists
      const oldestPath = `${this.logFilePath}.${this.config.maxFiles}`;
      if (existsSync(oldestPath)) {
        unlinkSync(oldestPath);
      }

      // Shift existing rotated files
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const oldPath = `${this.logFilePath}.${i}`;
        const newPath = `${this.logFilePath}.${i + 1}`;
        if (existsSync(oldPath)) {
          renameSync(oldPath, newPath);
        }
      }

      // Rotate current file to .1
      if (existsSync(this.logFilePath)) {
        renameSync(this.logFilePath, `${this.logFilePath}.1`);
      }
    } catch (error) {
      // If rotation fails, continue logging to current file
      console.error("[Logger] Rotation failed:", error);
    }
  }

  /**
   * Write log entry to file and optionally console
   */
  private write(level: LogLevel, component: string, message: string, meta?: object): void {
    if (level < this.config.level) {
      return;
    }

    const formatted = this.formatMessage(level, component, message, meta);

    // Console output
    if (this.config.consoleOutput) {
      if (level >= LogLevel.ERROR) {
        console.error(formatted);
      } else {
        console.log(formatted);
      }
    }

    // File output
    try {
      this.checkRotation();
      appendFileSync(this.logFilePath, formatted + "\n");
    } catch {
      // Ignore file write errors
    }
  }

  // Log methods for different levels
  debug(component: string, message: string, meta?: object): void {
    this.write(LogLevel.DEBUG, component, message, meta);
  }

  info(component: string, message: string, meta?: object): void {
    this.write(LogLevel.INFO, component, message, meta);
  }

  warn(component: string, message: string, meta?: object): void {
    this.write(LogLevel.WARN, component, message, meta);
  }

  error(component: string, message: string, meta?: object): void {
    this.write(LogLevel.ERROR, component, message, meta);
  }

  fatal(component: string, message: string, meta?: object): void {
    this.write(LogLevel.FATAL, component, message, meta);
  }
}

// Singleton logger instance
let globalLogger: Logger | null = null;

/**
 * Get or create the global logger instance
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger("Global");
  }
  return globalLogger;
}

/**
 * Create a scoped logger that prefixes all messages with a component name
 */
export function createLogger(component: string): {
  debug: (message: string, meta?: object) => void;
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  fatal: (message: string, meta?: object) => void;
} {
  const logger = getLogger();
  return {
    debug: (message: string, meta?: object) => logger.debug(component, message, meta),
    info: (message: string, meta?: object) => logger.info(component, message, meta),
    warn: (message: string, meta?: object) => logger.warn(component, message, meta),
    error: (message: string, meta?: object) => logger.error(component, message, meta),
    fatal: (message: string, meta?: object) => logger.fatal(component, message, meta),
  };
}

/**
 * Create a logger with custom file (e.g., for hooks with separate log file)
 */
export function createFileLogger(
  component: string,
  filename: string
): {
  debug: (message: string, meta?: object) => void;
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  fatal: (message: string, meta?: object) => void;
} {
  const logger = new Logger(component, { filename, consoleOutput: false });
  return {
    debug: (message: string, meta?: object) => logger.debug(component, message, meta),
    info: (message: string, meta?: object) => logger.info(component, message, meta),
    warn: (message: string, meta?: object) => logger.warn(component, message, meta),
    error: (message: string, meta?: object) => logger.error(component, message, meta),
    fatal: (message: string, meta?: object) => logger.fatal(component, message, meta),
  };
}
