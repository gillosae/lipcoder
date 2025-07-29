import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
import { stopReading } from './stop_reading';
import { stopAllAudio } from './stop_reading';
import { logWarning, logError, logSuccess } from '../utils';

let terminalLines: string[] = [];
let currentLineIndex = -1;
let currentCharIndex = -1;
let fallbackTerminal: vscode.Terminal | null = null;

/**
 * Clean up all terminal resources
 */
function cleanupTerminalResources(): void {
    logWarning('[Terminal] Cleaning up fallback terminal resources...');
    
    if (fallbackTerminal) {
        fallbackTerminal.dispose();
        fallbackTerminal = null;
    }
    
    terminalLines = [];
    currentLineIndex = -1;
    currentCharIndex = -1;
    
    logSuccess('[Terminal] Fallback terminal resources cleaned up');
}

/**
 * Fallback terminal implementation using VS Code's built-in terminal
 * This provides basic terminal functionality without node-pty dependency
 */
export function registerFallbackTerminalReader(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openTerminal', () => {
            logWarning('[Terminal] Using fallback terminal implementation (node-pty not available)');
            
            // Reset buffers
            terminalLines = [];
            currentLineIndex = -1;
            currentCharIndex = -1;

            // Create a standard VS Code terminal
            fallbackTerminal = vscode.window.createTerminal({
                name: 'LipCoder Terminal',
                shellPath: process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL'],
                cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath
            });
            
            fallbackTerminal.show();
            
            // Show a message about limited functionality
            vscode.window.showInformationMessage(
                'LipCoder Terminal: Using fallback mode. For full audio navigation, install and rebuild node-pty.'
            );
        }),

        // Navigate to next buffered terminal line (limited functionality in fallback)
        vscode.commands.registerCommand('lipcoder.terminalNextLine', async () => {
            stopReading();
            if (terminalLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            currentLineIndex = Math.min(currentLineIndex + 1, terminalLines.length - 1);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Navigate to previous buffered terminal line (limited functionality in fallback)
        vscode.commands.registerCommand('lipcoder.terminalPrevLine', async () => {
            stopReading();
            if (terminalLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            currentLineIndex = Math.max(currentLineIndex - 1, 0);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Move cursor left within current line buffer (limited functionality in fallback)
        vscode.commands.registerCommand('lipcoder.terminalCharLeft', async () => {
            stopReading();
            if (terminalLines.length === 0 || currentLineIndex < 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.max(currentCharIndex - 1, 0);
            const ch = line.charAt(currentCharIndex);
            if (ch) await speakTokenList([{ tokens: [ch], category: undefined }]);
        }),

        // Move cursor right within current line buffer (limited functionality in fallback)
        vscode.commands.registerCommand('lipcoder.terminalCharRight', async () => {
            stopReading();
            if (terminalLines.length === 0 || currentLineIndex < 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.min(currentCharIndex + 1, line.length - 1);
            const ch = line.charAt(currentCharIndex);
            if (ch) await speakTokenList([{ tokens: [ch], category: undefined }]);
        }),

        // Add a command to manually add terminal output for navigation
        vscode.commands.registerCommand('lipcoder.addTerminalOutput', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter terminal output to add for navigation',
                placeHolder: 'Terminal output...'
            });
            
            if (input && input.trim()) {
                terminalLines.push(input.trim());
                currentLineIndex = terminalLines.length - 1;
                currentCharIndex = -1;
                await speakTokenList([{ tokens: ['Added to terminal buffer'], category: undefined }]);
            }
        })
    );
    
    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupTerminalResources
    });
} 