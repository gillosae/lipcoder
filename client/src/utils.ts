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
 * Parse a filename to split extensions character by character and handle underscores
 * e.g., "university_spare.py" -> ["university", "_", "spare", ".", "p", "y"]
 * e.g., "requirements.txt" -> ["requirements", ".", "t", "x", "t"]
 */
export function parseFilename(filename: string): string[] {
    log(`[parseFilename] Called with filename: ${filename}`);
    
    const tokens: string[] = [];
    const dotIndex = filename.lastIndexOf('.');
    
    if (dotIndex === -1 || dotIndex === 0) {
        // No extension or hidden file - but still handle underscores
        log(`[parseFilename] No extension found, parsing underscores in: ${filename}`);
        parseNameWithUnderscores(filename, tokens);
    } else {
        // Split into name and extension
        const name = filename.substring(0, dotIndex);
        const extension = filename.substring(dotIndex + 1);
        
        log(`[parseFilename] Name: "${name}", Extension: "${extension}"`);
        
        // Parse name part (handle underscores)
        parseNameWithUnderscores(name, tokens);
        
        // Add dot
        tokens.push('.');
        
        // Split extension into individual characters
        for (const char of extension) {
            tokens.push(char);
        }
    }
    
    log(`[parseFilename] Result tokens: ${JSON.stringify(tokens)}`);
    return tokens;
}

/**
 * Helper function to parse a name with underscores
 * e.g., "university_spare" -> ["university", "_", "spare"]
 */
function parseNameWithUnderscores(name: string, tokens: string[]): void {
    const parts = name.split('_');
    
    for (let i = 0; i < parts.length; i++) {
        if (parts[i]) { // Skip empty parts
            tokens.push(parts[i]);
        }
        
        // Add underscore between parts (but not after the last part)
        if (i < parts.length - 1) {
            tokens.push('_');
        }
    }
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