import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk, playWave } from '../audio';
import { stopReading } from './stop_reading';
import { stopAllAudio } from './stop_reading';
import { logWarning, logError, logSuccess } from '../utils';
import { config } from '../config';
import * as path from 'path';

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
                
                // Simple content extraction - just get clean text lines
                const lines = data.split(/\r?\n/);
                for (const line of lines) {
                    const cleanLine = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').trim();
                    if (cleanLine && cleanLine.length > 0) {
                        terminalLines.push(cleanLine);
                        // Keep only recent lines to prevent memory issues
                        if (terminalLines.length > 100) {
                            terminalLines = terminalLines.slice(-50);
                            currentLineIndex = Math.min(currentLineIndex, terminalLines.length - 1);
                        }
                    }
                }
                
                currentLineIndex = terminalLines.length - 1;
                currentCharIndex = 0;
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
                handleInput: async (input: string) => {
                    // Handle special navigation keys with audio feedback
                    if (input === '\u001b[A') { // Up arrow
                        // Navigate to previous terminal line
                        if (terminalLines.length === 0) return;
                        stopReading();
                        currentLineIndex = Math.max(currentLineIndex - 1, 0);
                        currentCharIndex = 0;
                        const line = terminalLines[currentLineIndex];
                        
                        // Play navigation earcon for up movement
                        const upEarcon = path.join(config.audioPath(), 'earcon', 'indent_1.pcm');
                        await playWave(upEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                        
                        // Small delay to let earcon complete before TTS
                        await new Promise(resolve => setTimeout(resolve, 50));
                        
                        // Move cursor to line position with non-destructive highlighting
                        const linesToMoveUp = terminalLines.length - 1 - currentLineIndex;
                        const cursorOps = [
                            '\u001b[s', // Save cursor position
                            linesToMoveUp > 0 ? `\u001b[${linesToMoveUp}A` : '', // Move up to target line
                            '\u001b[1G', // Go to beginning of line
                            '\u001b[4m', // Start underline (non-destructive highlight)
                        ].filter(s => s).join('');
                        
                        writeEmitter.fire(cursorOps);
                        
                        // Brief pause to show position, then restore
                        setTimeout(() => {
                            writeEmitter.fire('\u001b[0m\u001b[u'); // Reset formatting and restore cursor
                        }, 300);
                        
                        // Use TTS with no category for terminal content
                        await speakTokenList([{ tokens: [line], category: undefined }]);
                        return; // Don't pass to PTY
                    }
                    
                    if (input === '\u001b[B') { // Down arrow
                        // Navigate to next terminal line
                        if (terminalLines.length === 0) return;
                        stopReading();
                        currentLineIndex = Math.min(currentLineIndex + 1, terminalLines.length - 1);
                        currentCharIndex = 0;
                        const line = terminalLines[currentLineIndex];
                        
                        // Play navigation earcon for down movement
                        const downEarcon = path.join(config.audioPath(), 'earcon', 'indent_2.pcm');
                        await playWave(downEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                        
                        // Small delay to let earcon complete before TTS
                        await new Promise(resolve => setTimeout(resolve, 50));
                        
                        // Move cursor to line position with non-destructive highlighting
                        const linesToMoveUp = terminalLines.length - 1 - currentLineIndex;
                        const cursorOps = [
                            '\u001b[s', // Save cursor position
                            linesToMoveUp > 0 ? `\u001b[${linesToMoveUp}A` : '', // Move up to target line
                            '\u001b[1G', // Go to beginning of line
                            '\u001b[4m', // Start underline (non-destructive highlight)
                        ].filter(s => s).join('');
                        
                        writeEmitter.fire(cursorOps);
                        
                        // Brief pause to show position, then restore
                        setTimeout(() => {
                            writeEmitter.fire('\u001b[0m\u001b[u'); // Reset formatting and restore cursor
                        }, 300);
                        
                        // Use TTS with no category for terminal content
                        await speakTokenList([{ tokens: [line], category: undefined }]);
                        return; // Don't pass to PTY
                    }
                    
                    if (input === '\u001b[D') { // Left arrow
                        // Navigate character left
                        if (terminalLines.length === 0 || currentLineIndex < 0) return;
                        stopReading();
                        const line = terminalLines[currentLineIndex];
                        currentCharIndex = Math.max(currentCharIndex - 1, 0);
                        const ch = line.charAt(currentCharIndex);
                        
                        // Play character navigation earcon for left movement
                        const leftEarcon = path.join(config.audioPath(), 'earcon', 'comma.pcm');
                        await playWave(leftEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                        
                        // Small delay to let earcon complete before TTS
                        await new Promise(resolve => setTimeout(resolve, 50));
                        
                        // Move cursor to character position with highlighting
                        if (ch) {
                            const linesToMoveUp = terminalLines.length - 1 - currentLineIndex;
                            const cursorOps = [
                                '\u001b[s', // Save cursor position
                                linesToMoveUp > 0 ? `\u001b[${linesToMoveUp}A` : '', // Move up to target line
                                `\u001b[${currentCharIndex + 1}G`, // Move to character position
                                '\u001b[7m', // Reverse video highlight for character
                            ].filter(s => s).join('');
                            
                            writeEmitter.fire(cursorOps);
                            
                            // Brief pause to show character position, then restore
                            setTimeout(() => {
                                writeEmitter.fire('\u001b[0m\u001b[u'); // Reset formatting and restore cursor
                            }, 300);
                        }
                        
                        // Use TTS with no category for character content
                        if (ch) await speakTokenList([{ tokens: [ch], category: undefined }]);
                        return; // Don't pass to PTY
                    }
                    
                    if (input === '\u001b[C') { // Right arrow
                        // Navigate character right
                        if (terminalLines.length === 0 || currentLineIndex < 0) return;
                        stopReading();
                        const line = terminalLines[currentLineIndex];
                        currentCharIndex = Math.min(currentCharIndex + 1, line.length - 1);
                        const ch = line.charAt(currentCharIndex);
                        
                        // Play character navigation earcon for right movement
                        const rightEarcon = path.join(config.audioPath(), 'earcon', 'dot.pcm');
                        await playWave(rightEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                        
                        // Small delay to let earcon complete before TTS
                        await new Promise(resolve => setTimeout(resolve, 50));
                        
                        // Move cursor to character position with highlighting
                        if (ch) {
                            const linesToMoveUp = terminalLines.length - 1 - currentLineIndex;
                            const cursorOps = [
                                '\u001b[s', // Save cursor position
                                linesToMoveUp > 0 ? `\u001b[${linesToMoveUp}A` : '', // Move up to target line
                                `\u001b[${currentCharIndex + 1}G`, // Move to character position
                                '\u001b[7m', // Reverse video highlight for character
                            ].filter(s => s).join('');
                            
                            writeEmitter.fire(cursorOps);
                            
                            // Brief pause to show character position, then restore
                            setTimeout(() => {
                                writeEmitter.fire('\u001b[0m\u001b[u'); // Reset formatting and restore cursor
                            }, 300);
                        }
                        
                        // Use TTS with no category for character content
                        if (ch) await speakTokenList([{ tokens: [ch], category: undefined }]);
                        return; // Don't pass to PTY
                    }
                    
                    // For regular input, stop any other speech and proceed normally
                    stopAllAudio();
                    // Write into the PTY (handles erase/backspace)
                    ptyProcess.write(input);
                    // Echo each character spoken using speakTokenList with no category
                    const chunks: TokenChunk[] = input.split('').map(ch => ({
                        tokens: [ch],
                        category: undefined
                    }));
                    await speakTokenList(chunks);
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
            
            // Play navigation earcon
            const downEarcon = path.join(config.audioPath(), 'earcon', 'indent_2.pcm');
            await playWave(downEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            await new Promise(resolve => setTimeout(resolve, 50));
            
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Navigate to previous buffered terminal line and speak it
        vscode.commands.registerCommand('lipcoder.terminalPrevLine', async () => {
            if (terminalLines.length === 0) return;
            stopReading();
            currentLineIndex = Math.max(currentLineIndex - 1, 0);
            currentCharIndex = -1;
            const line = terminalLines[currentLineIndex];
            
            // Play navigation earcon
            const upEarcon = path.join(config.audioPath(), 'earcon', 'indent_1.pcm');
            await playWave(upEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            await new Promise(resolve => setTimeout(resolve, 50));
            
            await speakTokenList([{ tokens: [line], category: undefined }]);
        }),

        // Move cursor left within current line buffer and speak character
        vscode.commands.registerCommand('lipcoder.terminalCharLeft', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.max(currentCharIndex - 1, 0);
            const ch = line.charAt(currentCharIndex);
            
            // Play character navigation earcon
            const leftEarcon = path.join(config.audioPath(), 'earcon', 'comma.pcm');
            await playWave(leftEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            if (ch) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: [ch], category: undefined }]);
            }
        }),

        // Move cursor right within current line buffer and speak character
        vscode.commands.registerCommand('lipcoder.terminalCharRight', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.min(currentCharIndex + 1, line.length - 1);
            const ch = line.charAt(currentCharIndex);
            
            // Play character navigation earcon
            const rightEarcon = path.join(config.audioPath(), 'earcon', 'dot.pcm');
            await playWave(rightEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            if (ch) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: [ch], category: undefined }]);
            }
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
                
                // Play confirmation earcon
                const confirmEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
                await playWave(confirmEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                // Small delay to let earcon complete before TTS
                await new Promise(resolve => setTimeout(resolve, 50));
                
                await speakTokenList([{ tokens: ['Added to terminal buffer'], category: undefined }]);
            }
        })
    );
    
    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupTerminalResources
    });
}