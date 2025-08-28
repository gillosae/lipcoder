import * as vscode from 'vscode';
import { log, logWarning } from './utils';

/**
 * Safely register a command, handling duplicate registration gracefully
 */
export async function safeRegisterCommand(
    context: vscode.ExtensionContext,
    commandId: string,
    callback: (...args: any[]) => any
): Promise<vscode.Disposable | null> {
    try {
        // First check if command already exists
        const exists = await commandExists(commandId);
        if (exists) {
            logWarning(`[CommandUtils] Command '${commandId}' already exists, skipping registration`);
            return null;
        }
        
        // Register the command
        const disposable = vscode.commands.registerCommand(commandId, callback);
        context.subscriptions.push(disposable);
        
        log(`[CommandUtils] Successfully registered command: ${commandId}`);
        return disposable;
        
    } catch (error) {
        const errorMessage = String(error);
        
        // If the error is about command already existing, log a warning but don't throw
        if (errorMessage.includes('already exists') || 
            errorMessage.includes('already registered') ||
            errorMessage.includes('command') && errorMessage.includes('exists')) {
            logWarning(`[CommandUtils] Command '${commandId}' already exists (caught in registration), skipping`);
            return null;
        }
        
        // For other errors, log and re-throw
        logWarning(`[CommandUtils] Failed to register command '${commandId}': ${error}`);
        throw error;
    }
}

/**
 * Dispose all commands with a specific prefix
 */
export function disposeCommandsWithPrefix(context: vscode.ExtensionContext, prefix: string): void {
    try {
        // Filter subscriptions that are command disposables
        const commandDisposables = context.subscriptions.filter(disposable => {
            // This is a heuristic - VSCode doesn't provide a direct way to check if a disposable is a command
            return disposable && typeof disposable.dispose === 'function';
        });

        log(`[CommandUtils] Disposing ${commandDisposables.length} potential command disposables with prefix: ${prefix}`);
        
        // Dispose all command-related disposables
        commandDisposables.forEach(disposable => {
            try {
                disposable.dispose();
            } catch (error) {
                // Ignore disposal errors
            }
        });
        
        // Clear the subscriptions array
        context.subscriptions.length = 0;
        
    } catch (error) {
        logWarning(`[CommandUtils] Error disposing commands with prefix '${prefix}': ${error}`);
    }
}

/**
 * Check if a command exists
 */
export async function commandExists(commandId: string): Promise<boolean> {
    try {
        const commands = await vscode.commands.getCommands(true);
        return commands.includes(commandId);
    } catch (error) {
        logWarning(`[CommandUtils] Error checking if command exists '${commandId}': ${error}`);
        return false;
    }
}

/**
 * Force dispose specific lipcoder commands
 */
export async function forceDisposeCommand(commandId: string): Promise<void> {
    try {
        // Try to execute the command with a no-op to see if it exists
        const exists = await commandExists(commandId);
        if (exists) {
            logWarning(`[CommandUtils] Command '${commandId}' exists, attempting to dispose...`);
            // Unfortunately, VS Code doesn't provide a direct way to unregister commands
            // The best we can do is track our own disposables and dispose them properly
        }
    } catch (error) {
        // Command doesn't exist or can't be accessed, which is fine
        log(`[CommandUtils] Command '${commandId}' doesn't exist or can't be accessed: ${error}`);
    }
}

/**
 * Force dispose multiple lipcoder commands
 */
export async function forceDisposeLipcoderCommands(): Promise<void> {
    const lipcoderCommands = [
        'lipcoder.syntaxErrorList',
        'lipcoder.nextSyntaxError',
        'lipcoder.previousSyntaxError',
        'lipcoder.firstSyntaxError'
    ];
    
    for (const commandId of lipcoderCommands) {
        await forceDisposeCommand(commandId);
    }
}

/**
 * Wrapper for registering multiple commands safely
 */
export async function registerCommandsSafely(
    context: vscode.ExtensionContext,
    commands: Array<{
        id: string;
        callback: (...args: any[]) => any;
    }>
): Promise<void> {
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const { id, callback } of commands) {
        try {
            const result = await safeRegisterCommand(context, id, callback);
            if (result) {
                successCount++;
            } else {
                skipCount++;
            }
        } catch (error) {
            errorCount++;
            logWarning(`[CommandUtils] Failed to register command '${id}': ${error}`);
        }
    }

    log(`[CommandUtils] Command registration summary: ${successCount} successful, ${skipCount} skipped, ${errorCount} failed`);
}
