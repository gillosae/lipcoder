import { lipcoderLog } from './logger';

// ANSI color codes for console output
const Colors = {
    Reset: '\x1b[0m',
    Bright: '\x1b[1m',
    Dim: '\x1b[2m',
    
    // Basic colors
    Red: '\x1b[31m',
    Green: '\x1b[32m',
    Yellow: '\x1b[33m',
    Blue: '\x1b[34m',
    Magenta: '\x1b[35m',
    Cyan: '\x1b[36m',
    White: '\x1b[37m',
    
    // Bright colors
    BrightRed: '\x1b[91m',
    BrightGreen: '\x1b[92m',
    BrightYellow: '\x1b[93m',
    BrightBlue: '\x1b[94m',
    BrightMagenta: '\x1b[95m',
    BrightCyan: '\x1b[96m',
    BrightWhite: '\x1b[97m',
    
    // Purple (alias for Magenta)
    Purple: '\x1b[35m',
    BrightPurple: '\x1b[95m'
} as const;

type ColorName = keyof typeof Colors;

/**
 * Log a message with optional color formatting
 */
export function log(message: string, color?: ColorName): void {
    const colorCode = color ? Colors[color] : '';
    const resetCode = color ? Colors.Reset : '';
    const formattedMessage = `${colorCode}${message}${resetCode}`;
    
    // Log to console (Developer Console)
    console.log(formattedMessage);
    
    // Also log to the LipCoder output channel
    lipcoderLog.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Log a memory-related message in purple
 */
export function logMemory(message: string): void {
    log(message, 'BrightPurple');
}

/**
 * Log an error message in red
 */
export function logError(message: string): void {
    log(message, 'BrightRed');
}

/**
 * Log a warning message in yellow
 */
export function logWarning(message: string): void {
    log(message, 'BrightYellow');
}

/**
 * Log a success message in green
 */
export function logSuccess(message: string): void {
    log(message, 'BrightGreen');
}

/**
 * Log an info message in blue
 */
export function logInfo(message: string): void {
    log(message, 'BrightBlue');
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Initialize logging and show the output channel
 */
export function initializeLogging(): void {
    // Show the LipCoder output channel so it appears in the dropdown
    lipcoderLog.show(true);
    
    // Log startup message
    log('[LipCoder] Logging initialized - debug output ready', 'BrightGreen');
}