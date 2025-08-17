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
let realCursorLine = -1; // Track the actual terminal cursor position
let realCursorColumn = -1;

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
    realCursorLine = -1;
    realCursorColumn = -1;
    
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
            realCursorLine = -1;
            realCursorColumn = -1;

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
                
                // Improved content extraction with better ANSI handling
                const lines = data.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    
                    // Remove ANSI escape sequences but preserve content structure
                    const cleanLine = line
                        .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape sequences
                        .replace(/\u001b\]0;.*?\u0007/g, '') // Remove terminal title sequences
                        .replace(/\u001b\[[\d;]*[HfABCDsuK]/g, '') // Remove cursor movement sequences
                        .replace(/\r/g, ''); // Remove carriage returns
                    
                    // Only add non-empty lines or preserve structure for empty lines in middle of output
                    if (cleanLine.length > 0 || (i > 0 && i < lines.length - 1)) {
                        // If this is updating an existing line (carriage return behavior)
                        if (line.includes('\r') && terminalLines.length > 0) {
                            terminalLines[terminalLines.length - 1] = cleanLine;
                        } else {
                            terminalLines.push(cleanLine);
                        }
                        
                        // Keep only recent lines to prevent memory issues
                        if (terminalLines.length > 200) {
                            terminalLines = terminalLines.slice(-100);
                            currentLineIndex = Math.min(currentLineIndex, terminalLines.length - 1);
                        }
                    }
                }
                
                // Update cursor position to latest content
                if (terminalLines.length > 0) {
                    currentLineIndex = terminalLines.length - 1;
                    currentCharIndex = 0;
                    realCursorLine = currentLineIndex;
                    realCursorColumn = terminalLines[currentLineIndex]?.length || 0;
                }
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
            if (terminalLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            stopReading();
            
            // Initialize currentLineIndex if it's -1
            if (currentLineIndex < 0) {
                currentLineIndex = 0;
            } else {
                currentLineIndex = Math.min(currentLineIndex + 1, terminalLines.length - 1);
            }
            currentCharIndex = 0;
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
            if (terminalLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            stopReading();
            
            // Initialize currentLineIndex if it's -1
            if (currentLineIndex < 0) {
                currentLineIndex = 0;
            } else {
                currentLineIndex = Math.max(currentLineIndex - 1, 0);
            }
            currentCharIndex = 0;
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
            if (terminalLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            if (currentLineIndex < 0) {
                currentLineIndex = 0;
                currentCharIndex = 0;
            }
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
            if (terminalLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal output to navigate'], category: undefined }]);
                return;
            }
            if (currentLineIndex < 0) {
                currentLineIndex = 0;
                currentCharIndex = 0;
            }
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

        // Move cursor to beginning of current line
        vscode.commands.registerCommand('lipcoder.terminalLineStart', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            currentCharIndex = 0;
            const line = terminalLines[currentLineIndex];
            const ch = line.charAt(currentCharIndex);
            
            // Play line start earcon
            const startEarcon = path.join(config.audioPath(), 'earcon', 'indent_0.pcm');
            await playWave(startEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            if (ch) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: ['line start', ch], category: undefined }]);
            }
        }),

        // Move cursor to end of current line
        vscode.commands.registerCommand('lipcoder.terminalLineEnd', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            currentCharIndex = Math.max(line.length - 1, 0);
            const ch = line.charAt(currentCharIndex);
            
            // Play line end earcon
            const endEarcon = path.join(config.audioPath(), 'earcon', 'indent_9.pcm');
            await playWave(endEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            if (ch) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: ['line end', ch], category: undefined }]);
            }
        }),

        // Move cursor to previous word
        vscode.commands.registerCommand('lipcoder.terminalWordLeft', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            
            // Find previous word boundary
            let newIndex = currentCharIndex - 1;
            // Skip current whitespace
            while (newIndex >= 0 && /\s/.test(line[newIndex])) {
                newIndex--;
            }
            // Skip current word
            while (newIndex >= 0 && !/\s/.test(line[newIndex])) {
                newIndex--;
            }
            // Move to start of previous word
            while (newIndex >= 0 && /\s/.test(line[newIndex])) {
                newIndex--;
            }
            while (newIndex >= 0 && !/\s/.test(line[newIndex])) {
                newIndex--;
            }
            newIndex++; // Move to first character of word
            
            currentCharIndex = Math.max(newIndex, 0);
            
            // Extract the word at current position
            let wordStart = currentCharIndex;
            let wordEnd = currentCharIndex;
            while (wordEnd < line.length && !/\s/.test(line[wordEnd])) {
                wordEnd++;
            }
            const word = line.substring(wordStart, wordEnd);
            
            // Play word navigation earcon
            const wordEarcon = path.join(config.audioPath(), 'earcon', 'parenthesis.pcm');
            await playWave(wordEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            if (word) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: [word], category: undefined }]);
            }
        }),

        // Move cursor to next word
        vscode.commands.registerCommand('lipcoder.terminalWordRight', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            
            // Find next word boundary
            let newIndex = currentCharIndex;
            // Skip current word
            while (newIndex < line.length && !/\s/.test(line[newIndex])) {
                newIndex++;
            }
            // Skip whitespace
            while (newIndex < line.length && /\s/.test(line[newIndex])) {
                newIndex++;
            }
            
            currentCharIndex = Math.min(newIndex, line.length - 1);
            
            // Extract the word at current position
            let wordStart = currentCharIndex;
            let wordEnd = currentCharIndex;
            while (wordEnd < line.length && !/\s/.test(line[wordEnd])) {
                wordEnd++;
            }
            const word = line.substring(wordStart, wordEnd);
            
            // Play word navigation earcon
            const wordEarcon = path.join(config.audioPath(), 'earcon', 'parenthesis2.pcm');
            await playWave(wordEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            if (word) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: [word], category: undefined }]);
            }
        }),

        // Read current line in terminal
        vscode.commands.registerCommand('lipcoder.terminalReadLine', async () => {
            if (terminalLines.length === 0 || currentLineIndex < 0) return;
            stopReading();
            const line = terminalLines[currentLineIndex];
            
            // Play read line earcon
            const readEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
            await playWave(readEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            await new Promise(resolve => setTimeout(resolve, 50));
            
            await speakTokenList([{ tokens: [line || 'empty line'], category: undefined }]);
        }),

        // Jump to first line in terminal buffer
        vscode.commands.registerCommand('lipcoder.terminalFirstLine', async () => {
            if (terminalLines.length === 0) return;
            stopReading();
            currentLineIndex = 0;
            currentCharIndex = 0;
            const line = terminalLines[currentLineIndex];
            
            // Play first line earcon
            const firstEarcon = path.join(config.audioPath(), 'musical', 'do.pcm');
            await playWave(firstEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            await new Promise(resolve => setTimeout(resolve, 50));
            
            await speakTokenList([{ tokens: ['first line', line], category: undefined }]);
        }),

        // Jump to last line in terminal buffer
        vscode.commands.registerCommand('lipcoder.terminalLastLine', async () => {
            if (terminalLines.length === 0) return;
            stopReading();
            currentLineIndex = terminalLines.length - 1;
            currentCharIndex = 0;
            const line = terminalLines[currentLineIndex];
            
            // Play last line earcon
            const lastEarcon = path.join(config.audioPath(), 'musical', 'high_do.pcm');
            await playWave(lastEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            // Small delay to let earcon complete before TTS
            await new Promise(resolve => setTimeout(resolve, 50));
            
            await speakTokenList([{ tokens: ['last line', line], category: undefined }]);
        }),

        // Search within terminal output
        vscode.commands.registerCommand('lipcoder.terminalSearch', async () => {
            const searchTerm = await vscode.window.showInputBox({
                prompt: 'Search terminal output',
                placeHolder: 'Enter search term...'
            });
            
            if (!searchTerm || !searchTerm.trim()) return;
            
            const term = searchTerm.trim().toLowerCase();
            const matches: { lineIndex: number, line: string, matchIndex: number }[] = [];
            
            // Find all matches
            for (let i = 0; i < terminalLines.length; i++) {
                const line = terminalLines[i];
                const lowerLine = line.toLowerCase();
                let matchIndex = lowerLine.indexOf(term);
                
                while (matchIndex !== -1) {
                    matches.push({ lineIndex: i, line, matchIndex });
                    matchIndex = lowerLine.indexOf(term, matchIndex + 1);
                }
            }
            
            if (matches.length === 0) {
                // Play not found earcon
                const notFoundEarcon = path.join(config.audioPath(), 'earcon', 'question.pcm');
                await playWave(notFoundEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: ['Not found'], category: undefined }]);
                return;
            }
            
            // Jump to first match
            const firstMatch = matches[0];
            currentLineIndex = firstMatch.lineIndex;
            currentCharIndex = firstMatch.matchIndex;
            
            // Play search success earcon
            const foundEarcon = path.join(config.audioPath(), 'earcon', 'excitation.pcm');
            await playWave(foundEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Announce the match with context
            const contextStart = Math.max(0, firstMatch.matchIndex - 10);
            const contextEnd = Math.min(firstMatch.line.length, firstMatch.matchIndex + term.length + 10);
            const context = firstMatch.line.substring(contextStart, contextEnd);
            
            await speakTokenList([
                { tokens: [`Found ${matches.length} matches`], category: undefined },
                { tokens: [context], category: undefined }
            ]);
        }),

        // Find next search result
        vscode.commands.registerCommand('lipcoder.terminalSearchNext', async () => {
            // This would need to store the last search term and current match index
            // For now, just re-run the search command
            await vscode.commands.executeCommand('lipcoder.terminalSearch');
        }),

        // Get terminal status/info
        vscode.commands.registerCommand('lipcoder.terminalStatus', async () => {
            stopReading();
            
            const totalLines = terminalLines.length;
            const currentPos = currentLineIndex + 1;
            const currentLine = terminalLines[currentLineIndex] || '';
            const charPos = currentCharIndex + 1;
            
            // Play status earcon
            const statusEarcon = path.join(config.audioPath(), 'earcon', 'colon.pcm');
            await playWave(statusEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            await speakTokenList([
                { tokens: [`Line ${currentPos} of ${totalLines}`], category: undefined },
                { tokens: [`Character ${charPos} of ${currentLine.length}`], category: undefined }
            ]);
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