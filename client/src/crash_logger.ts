import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

// 로그 파일 경로 설정
const LOG_DIR = path.join(os.homedir(), '.lipcoder', 'logs');
const CRASH_LOG_FILE = path.join(LOG_DIR, 'crash.log');
const DEBUG_LOG_FILE = path.join(LOG_DIR, 'debug.log');
const PERFORMANCE_LOG_FILE = path.join(LOG_DIR, 'performance.log');

// 로그 레벨 정의
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    FATAL = 4
}

// 로그 항목 인터페이스
interface LogEntry {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    stack?: string;
    metadata?: any;
}

class CrashLogger {
    private initialized = false;
    private logQueue: LogEntry[] = [];
    private flushInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.initialize();
        this.setupGlobalErrorHandlers();
        this.startPeriodicFlush();
    }

    private initialize(): void {
        try {
            // 로그 디렉토리 생성
            if (!fs.existsSync(LOG_DIR)) {
                fs.mkdirSync(LOG_DIR, { recursive: true });
            }

            // 로그 파일 초기화 (기존 로그는 .old로 백업)
            this.rotateLogFile(DEBUG_LOG_FILE);
            this.rotateLogFile(PERFORMANCE_LOG_FILE);
            
            this.initialized = true;
            this.log(LogLevel.INFO, 'CrashLogger', 'Crash logging system initialized');
        } catch (error) {
            console.error('[CrashLogger] Failed to initialize:', error);
        }
    }

    private rotateLogFile(filePath: string): void {
        if (fs.existsSync(filePath)) {
            const oldFilePath = filePath + '.old';
            try {
                if (fs.existsSync(oldFilePath)) {
                    fs.unlinkSync(oldFilePath);
                }
                fs.renameSync(filePath, oldFilePath);
            } catch (error) {
                console.error(`[CrashLogger] Failed to rotate log file ${filePath}:`, error);
            }
        }
    }

    private setupGlobalErrorHandlers(): void {
        // Node.js 전역 에러 핸들러
        process.on('uncaughtException', (error) => {
            this.logCrash('UncaughtException', error);
            // 크래시 로그를 즉시 플러시
            this.flushLogs();
        });

        process.on('unhandledRejection', (reason, promise) => {
            this.logCrash('UnhandledRejection', reason as Error, { promise: promise.toString() });
            this.flushLogs();
        });

        // VS Code 확장 에러 핸들러
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('error', (event) => {
                this.logCrash('WindowError', event.error, {
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno
                });
            });

            window.addEventListener('unhandledrejection', (event) => {
                this.logCrash('WindowUnhandledRejection', event.reason);
            });
        }
    }

    private startPeriodicFlush(): void {
        // 5초마다 로그 플러시
        this.flushInterval = setInterval(() => {
            this.flushLogs();
        }, 5000);
    }

    public log(level: LogLevel, category: string, message: string, metadata?: any, error?: Error): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            category,
            message,
            metadata
        };

        if (error) {
            entry.stack = error.stack;
        }

        this.logQueue.push(entry);

        // 에러 레벨 이상은 즉시 플러시
        if (level >= LogLevel.ERROR) {
            this.flushLogs();
        }

        // 콘솔에도 출력
        this.logToConsole(entry);
    }

    public logCrash(type: string, error: Error | any, metadata?: any): void {
        const crashEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: LogLevel.FATAL,
            category: 'CRASH',
            message: `${type}: ${error?.message || error}`,
            stack: error?.stack,
            metadata: {
                ...metadata,
                type,
                errorName: error?.name,
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                memoryUsage: process.memoryUsage(),
                uptime: process.uptime()
            }
        };

        this.logQueue.push(crashEntry);
        this.flushCrashLog(crashEntry);
        
        // VS Code 상태바에 크래시 알림
        vscode.window.setStatusBarMessage('⚠️ LipCoder crash detected - check logs', 10000);
    }

    public logPerformance(operation: string, duration: number, metadata?: any): void {
        const perfEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: LogLevel.INFO,
            category: 'PERFORMANCE',
            message: `${operation} took ${duration}ms`,
            metadata: {
                ...metadata,
                operation,
                duration,
                memoryUsage: process.memoryUsage()
            }
        };

        this.logQueue.push(perfEntry);
        this.flushPerformanceLog(perfEntry);
    }

    public logTypingEvent(event: string, details?: any): void {
        this.log(LogLevel.DEBUG, 'TYPING', event, {
            ...details,
            timestamp: Date.now(),
            memoryUsage: process.memoryUsage()
        });
    }

    private logToConsole(entry: LogEntry): void {
        const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
        const levelColors = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[31m', '\x1b[35m'];
        
        const color = levelColors[entry.level] || '';
        const reset = '\x1b[0m';
        
        console.log(`${color}[${entry.timestamp}] [${levelNames[entry.level]}] [${entry.category}] ${entry.message}${reset}`);
        
        if (entry.stack) {
            console.log(`${color}Stack: ${entry.stack}${reset}`);
        }
        
        if (entry.metadata) {
            console.log(`${color}Metadata:`, entry.metadata, reset);
        }
    }

    private flushLogs(): void {
        if (!this.initialized || this.logQueue.length === 0) {
            return;
        }

        try {
            const logLines = this.logQueue.map(entry => this.formatLogEntry(entry));
            fs.appendFileSync(DEBUG_LOG_FILE, logLines.join('\n') + '\n');
            this.logQueue = [];
        } catch (error) {
            console.error('[CrashLogger] Failed to flush logs:', error);
        }
    }

    private flushCrashLog(entry: LogEntry): void {
        try {
            const crashLine = this.formatLogEntry(entry);
            fs.appendFileSync(CRASH_LOG_FILE, crashLine + '\n');
        } catch (error) {
            console.error('[CrashLogger] Failed to write crash log:', error);
        }
    }

    private flushPerformanceLog(entry: LogEntry): void {
        try {
            const perfLine = this.formatLogEntry(entry);
            fs.appendFileSync(PERFORMANCE_LOG_FILE, perfLine + '\n');
        } catch (error) {
            console.error('[CrashLogger] Failed to write performance log:', error);
        }
    }

    private formatLogEntry(entry: LogEntry): string {
        const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
        let formatted = `[${entry.timestamp}] [${levelNames[entry.level]}] [${entry.category}] ${entry.message}`;
        
        if (entry.stack) {
            formatted += `\nStack: ${entry.stack}`;
        }
        
        if (entry.metadata) {
            formatted += `\nMetadata: ${JSON.stringify(entry.metadata, null, 2)}`;
        }
        
        return formatted;
    }

    public getLogDirectory(): string {
        return LOG_DIR;
    }

    public cleanup(): void {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
        this.flushLogs();
    }
}

// 싱글톤 인스턴스
export const crashLogger = new CrashLogger();

// 편의 함수들
export function logDebug(category: string, message: string, metadata?: any): void {
    crashLogger.log(LogLevel.DEBUG, category, message, metadata);
}

export function logInfo(category: string, message: string, metadata?: any): void {
    crashLogger.log(LogLevel.INFO, category, message, metadata);
}

export function logWarn(category: string, message: string, metadata?: any): void {
    crashLogger.log(LogLevel.WARN, category, message, metadata);
}

export function logError(category: string, message: string, error?: Error, metadata?: any): void {
    crashLogger.log(LogLevel.ERROR, category, message, metadata, error);
}

export function logFatal(category: string, message: string, error?: Error, metadata?: any): void {
    crashLogger.log(LogLevel.FATAL, category, message, metadata, error);
}

export function logTyping(event: string, details?: any): void {
    crashLogger.logTypingEvent(event, details);
}

export function logPerformance(operation: string, duration: number, metadata?: any): void {
    crashLogger.logPerformance(operation, duration, metadata);
}

// 성능 측정 헬퍼
export function measurePerformance<T>(operation: string, fn: () => T, metadata?: any): T {
    const start = Date.now();
    try {
        const result = fn();
        const duration = Date.now() - start;
        logPerformance(operation, duration, metadata);
        return result;
    } catch (error) {
        const duration = Date.now() - start;
        logError('PERFORMANCE', `${operation} failed after ${duration}ms`, error as Error, metadata);
        throw error;
    }
}

// 비동기 성능 측정 헬퍼
export async function measurePerformanceAsync<T>(operation: string, fn: () => Promise<T>, metadata?: any): Promise<T> {
    const start = Date.now();
    try {
        const result = await fn();
        const duration = Date.now() - start;
        logPerformance(operation, duration, metadata);
        return result;
    } catch (error) {
        const duration = Date.now() - start;
        logError('PERFORMANCE', `${operation} failed after ${duration}ms`, error as Error, metadata);
        throw error;
    }
}
