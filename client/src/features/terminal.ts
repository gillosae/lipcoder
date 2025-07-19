import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakToken, speakTokenList } from '../audio';
import { stopReadLineTokens } from './stop_read_line_tokens';
import { stopPlayback } from '../audio';

let terminalLines: string[] = [];
let currentLineIndex = -1;
let currentCharIndex = -1;

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
            } catch (err) {
                vscode.window.showErrorMessage(
                    'LipCoder: Failed to load node-pty. Ensure it is installed and rebuilt for VS Code\'s Electron: run `npm install node-pty && npm rebuild node-pty --runtime=electron --target=' + process.versions.electron + ' --disturl=https://atom.io/download/electron` in the client folder.'
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
                    // (Re)stop any other speech
                    stopReadLineTokens();
                    stopPlayback();
                    // Write into the PTY (handles erase/backspace)
                    ptyProcess.write(input);
                    // Echo each character spoken
                    for (const ch of input) {
                        speakToken(ch);
                    }
                }
            };

            // Show the custom terminal
            const terminal = vscode.window.createTerminal({ name: 'LipCoder', pty: ptyTerminal });
            terminal.show();
        }),

        // Navigate to next buffered terminal line and speak it
        vscode.commands.registerCommand('lipcoder.terminalNextLine', async () => {
            if (terminalLines.length === 0) return;
            stopReadLineTokens();
            currentLineIndex = Math.min(currentLineIndex + 1, terminalLines.length - 1);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Navigate to previous buffered terminal line and speak it
        vscode.commands.registerCommand('lipcoder.terminalPrevLine', async () => {
            if (terminalLines.length === 0) return;
            stopReadLineTokens();
            currentLineIndex = Math.max(currentLineIndex - 1, 0);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Move cursor left within current line buffer and speak character
        vscode.commands.registerCommand('lipcoder.terminalCharLeft', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReadLineTokens();
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.max(currentCharIndex - 1, 0);
            const ch = line.charAt(currentCharIndex);
            if (ch) await speakToken(ch);
        }),

        // Move cursor right within current line buffer and speak character
        vscode.commands.registerCommand('lipcoder.terminalCharRight', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReadLineTokens();
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.min(currentCharIndex + 1, line.length - 1);
            const ch = line.charAt(currentCharIndex);
            if (ch) await speakToken(ch);
        })
    );
}