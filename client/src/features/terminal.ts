import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk } from '../audio';
import { stopReading } from './stop_reading';
import { stopAllAudio } from './stop_reading';
import { logWarning, logError, logSuccess } from '../utils';

let terminalLines: string[] = [];
let currentLineIndex = -1;
let currentCharIndex = -1;
let activePtyProcesses = new Set<any>();

/**
 * Clean up all terminal resources
 */
function cleanupTerminalResources(): void {
    logWarning('[Terminal] Cleaning up terminal resources...');
    
    // Kill all active PTY processes
    for (const ptyProcess of activePtyProcesses) {
        try {
            if (ptyProcess && typeof ptyProcess.kill === 'function') {
                ptyProcess.kill('SIGKILL');
            }
        } catch (error) {
            logError(`[Terminal] Error killing PTY process: ${error}`);
        }
    }
    
    activePtyProcesses.clear();
    terminalLines = [];
    currentLineIndex = -1;
    currentCharIndex = -1;
    
    logSuccess('[Terminal] Terminal resources cleaned up');
}

/**
 * Registers terminal reader commands and a custom pseudoterminal
 * that echoes each typed character and buffers output lines.
 */
export function registerTerminalReader(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openTerminal', () => {
            let pty: any;
            try {
                pty = require('node-pty');
                logSuccess('[Terminal] node-pty loaded successfully');
            } catch (err) {
                logError(`[Terminal] Failed to load node-pty: ${err}`);
                
                // Fall back to basic terminal
                const fallbackTerminal = vscode.window.createTerminal({
                    name: 'LipCoder Terminal (Fallback)',
                    shellPath: process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL'],
                    cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath
                });
                
                fallbackTerminal.show();
                vscode.window.showWarningMessage(
                    'LipCoder Terminal: Using fallback mode due to node-pty error. Some features may be limited.'
                );
                return;
            }
            // Reset buffers
            terminalLines = [];
            currentLineIndex = -1;
            currentCharIndex = -1;

            // Spawn a real PTY running the user's shell
            const shell = process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL']!;
            const ptyProcess = pty.spawn(shell, [], {
                name: 'xterm-color',
                cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
                env: process.env
            });
            
            // Track this process for cleanup
            activePtyProcesses.add(ptyProcess);
            
            // Remove from tracking when it exits
            ptyProcess.onExit(() => {
                activePtyProcesses.delete(ptyProcess);
            });

            // Emitters for the terminal UI
            const writeEmitter = new vscode.EventEmitter<string>();
            const closeEmitter = new vscode.EventEmitter<void>();

            // Forward PTY output into VS Code terminal and buffer lines
            ptyProcess.onData((data: string) => {
                writeEmitter.fire(data);
                // Buffer each non-empty line for navigation
                const parts = data.split(/\r?\n/);
                for (const part of parts) {
                    if (part.trim()) {
                        terminalLines.push(part);
                    }
                }
                currentLineIndex = terminalLines.length - 1;
                currentCharIndex = -1;
            });
            ptyProcess.onExit(() => {
                closeEmitter.fire();
            });

            // Create a true PTY-based pseudoterminal
            const ptyTerminal: vscode.Pseudoterminal = {
                onDidWrite: writeEmitter.event,
                onDidClose: closeEmitter.event,
                open: () => { /* no-op */ },
                close: () => {
                    ptyProcess.kill();
                },
                handleInput: (input: string) => {
                    // (Re)stop any other speech using centralized system
                    stopAllAudio();
                    // Write into the PTY (handles erase/backspace)
                    ptyProcess.write(input);
                    // Echo each character spoken using speakTokenList
                    const chunks: TokenChunk[] = input.split('').map(ch => ({
                        tokens: [ch],
                        category: undefined
                    }));
                    speakTokenList(chunks);
                }
            };

            // Show the custom terminal
            const terminal = vscode.window.createTerminal({ name: 'LipCoder', pty: ptyTerminal });
            terminal.show();
        }),

        // Navigate to next buffered terminal line and speak it
        vscode.commands.registerCommand('lipcoder.terminalNextLine', async () => {
            if (terminalLines.length === 0) return;
            stopReading();
            currentLineIndex = Math.min(currentLineIndex + 1, terminalLines.length - 1);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Navigate to previous buffered terminal line and speak it
        vscode.commands.registerCommand('lipcoder.terminalPrevLine', async () => {
            if (terminalLines.length === 0) return;
            stopReading();
            currentLineIndex = Math.max(currentLineIndex - 1, 0);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Move cursor left within current line buffer and speak character
        vscode.commands.registerCommand('lipcoder.terminalCharLeft', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.max(currentCharIndex - 1, 0);
            const ch = line.charAt(currentCharIndex);
            if (ch) await speakTokenList([{ tokens: [ch], category: undefined }]);
        }),

        // Move cursor right within current line buffer and speak character
        vscode.commands.registerCommand('lipcoder.terminalCharRight', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
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