import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
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
            // Reset buffers
            terminalLines = [];
            currentLineIndex = -1;
            currentCharIndex = -1;

            // Spawn the user's shell as a background process
            const shell = process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL']!;
            const proc: ChildProcess = spawn(shell, [], {
                cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
                shell: true
            });

            // Event emitters for the pseudoterminal
            const writeEmitter = new vscode.EventEmitter<string>();
            const closeEmitter = new vscode.EventEmitter<void>();

            // Forward shell stdout into the VS Code terminal and buffer lines
            proc.stdout!.on('data', (chunk: Buffer) => {
                const data = chunk.toString();
                writeEmitter.fire(data);

                const parts = data.split(/\r?\n/);
                for (const part of parts) {
                    if (part.trim()) {
                        terminalLines.push(part);
                    }
                }
                currentLineIndex = terminalLines.length - 1;
                currentCharIndex = -1;
            });

            proc.stderr!.on('data', (chunk: Buffer) => {
                writeEmitter.fire(chunk.toString());
            });

            proc.on('close', () => {
                closeEmitter.fire();
            });

            // Create a pseudoterminal to drive the VS Code terminal UI
            const pty: vscode.Pseudoterminal = {
                onDidWrite: writeEmitter.event,
                onDidClose: closeEmitter.event,
                open: () => {
                    // No special setup needed on open
                },
                close: () => {
                    proc.kill();
                },
                handleInput: (data: string) => {
                    // Stop any ongoing line-read or other audio
                    stopReadLineTokens();
                    stopPlayback();

                    // Echo each typed character
                    for (const ch of data) {
                        speakToken(ch);
                    }

                    // Forward the input to the shell process
                    proc.stdin!.write(data);
                }
            };

            // Create and show the custom terminal
            const term = vscode.window.createTerminal({ name: 'LipCoder', pty });
            term.show();
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