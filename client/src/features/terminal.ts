import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, TokenChunk, playWave } from '../audio';
import { stopReading } from './stop_reading';
import { stopAllAudio } from './stop_reading';
import { logWarning, logError, logSuccess } from '../utils';
import { logFeatureUsage } from '../activity_logger';
import { config } from '../config';
import { isEarcon, specialCharMap } from '../mapping';
import * as path from 'path';

// Terminal screen buffer management
let terminalScreenLines: string[] = [];
let currentLineIndex = -1;
let activePtyProcesses = new Set<any>();
let hasNodePty = false;
let fallbackTerminal: vscode.Terminal | null = null;
let currentPtyProcess: any = null;
let terminalOutputBuffer: string[] = []; // Enhanced buffer for better output tracking

/**
 * Convert a terminal line into proper token chunks with categories and earcons
 */
function parseTerminalLineToTokens(line: string): TokenChunk[] {
    const chunks: TokenChunk[] = [];
    let currentToken = '';
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        // If we encounter a special character that should be an earcon
        if (isEarcon(char)) {
            // First, add any accumulated text as a regular token
            if (currentToken.trim().length > 0) {
                chunks.push({
                    tokens: [currentToken.trim()],
                    category: undefined
                });
                currentToken = '';
            }
            
            // Add the special character as its own earcon token
            chunks.push({
                tokens: [char],
                category: 'earcon'
            });
        } else if (char === ' ') {
            // Space separates tokens
            if (currentToken.trim().length > 0) {
                chunks.push({
                    tokens: [currentToken.trim()],
                    category: undefined
                });
                currentToken = '';
            }
        } else {
            // Regular character - accumulate
            currentToken += char;
        }
    }
    
    // Add any remaining token
    if (currentToken.trim().length > 0) {
        chunks.push({
            tokens: [currentToken.trim()],
            category: undefined
        });
    }
    
    return chunks;
}

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
    
    // Clean up fallback terminal
    if (fallbackTerminal) {
        fallbackTerminal.dispose();
        fallbackTerminal = null;
    }
    
    activePtyProcesses.clear();
    terminalScreenLines = [];
    terminalOutputBuffer = [];
    currentLineIndex = -1;
    currentPtyProcess = null;
    
    logSuccess('[Terminal] Terminal resources cleaned up');
}

/**
 * Get current terminal screen content
 */
function getCurrentScreenContent(): string[] {
    if (currentPtyProcess && typeof currentPtyProcess.getScreenContent === 'function') {
        try {
            return currentPtyProcess.getScreenContent();
        } catch (error) {
            logError(`[Terminal] Error getting screen content: ${error}`);
        }
    }
    
    // Fallback to stored screen lines
    return terminalScreenLines.filter(line => line.trim().length > 0);
}

/**
 * Update terminal screen buffer - capture complete lines only
 */
function updateScreenBuffer(data: string): void {
    // Accumulate data until we have complete lines
    terminalOutputBuffer.push(data);
    const fullBuffer = terminalOutputBuffer.join('');
    
    // Only process when we have complete lines (ending with newline)
    if (data.includes('\n') || data.includes('\r')) {
        // Split into lines and clean ANSI sequences
        const lines = fullBuffer.split(/\r?\n/);
        
        // Clear the buffer since we're processing it
        terminalOutputBuffer = [];
        
        // Keep the last incomplete line in buffer if any
        if (lines.length > 0 && !fullBuffer.endsWith('\n') && !fullBuffer.endsWith('\r')) {
            terminalOutputBuffer.push(lines.pop() || '');
        }
        
        for (const line of lines) {
            const cleanLine = line
                .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape sequences
                .replace(/\u001b\]0;.*?\u0007/g, '') // Remove terminal title sequences
                .replace(/\r/g, '') // Remove carriage returns
                .trim();
            
            // Only add meaningful lines (not empty, not just single characters)
            if (cleanLine.length > 2) {
                terminalScreenLines.push(cleanLine);
                logSuccess(`[Terminal] Added line: "${cleanLine}"`);
                
                // Keep a reasonable buffer size
                if (terminalScreenLines.length > 50) {
                    terminalScreenLines = terminalScreenLines.slice(-25);
                    if (currentLineIndex >= terminalScreenLines.length) {
                        currentLineIndex = terminalScreenLines.length - 1;
                    }
                }
            }
        }
        
        // Initialize to last line if not set
        if (currentLineIndex < 0 && terminalScreenLines.length > 0) {
            currentLineIndex = terminalScreenLines.length - 1;
        }
    }
}

/**
 * Create PTY-based terminal with screen buffer capture
 */
function createPtyTerminal(pty: any): void {
    logSuccess('[Terminal] Creating PTY-based terminal with screen buffer');
    hasNodePty = true;
    
    // Reset state
    terminalScreenLines = [];
    currentLineIndex = -1;

    // Spawn shell
    const shell = process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL']!;
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
        env: process.env
    });
    
    // Store current process reference
    currentPtyProcess = ptyProcess;
    
    // Track process
    activePtyProcesses.add(ptyProcess);
    ptyProcess.onExit(() => {
        activePtyProcesses.delete(ptyProcess);
        if (currentPtyProcess === ptyProcess) {
            currentPtyProcess = null;
        }
    });

    // Terminal emitters
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<void>();

    // Capture output and update screen buffer
    ptyProcess.onData((data: string) => {
        writeEmitter.fire(data);
        updateScreenBuffer(data);
    });

    // Simple pseudoterminal interface
    const ptyTerminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        
        open: () => {
            logSuccess('[Terminal] PTY terminal with screen buffer opened');
        },
        
        close: () => {
            logWarning('[Terminal] PTY terminal closed');
            ptyProcess.kill();
            closeEmitter.fire();
        },
        
        handleInput: async (input: string) => {
            // Intercept arrow keys for navigation
            if (input === '\u001b[A') { // Up arrow
                // Immediately stop all audio before navigation
                stopAllAudio();
                await vscode.commands.executeCommand('lipcoder.terminalHistoryUp');
                return;
            }
            if (input === '\u001b[B') { // Down arrow
                // Immediately stop all audio before navigation
                stopAllAudio();
                await vscode.commands.executeCommand('lipcoder.terminalHistoryDown');
                return;
            }
            
            // Pass through other input and echo characters
            stopAllAudio();
            ptyProcess.write(input);
            
            // Simple character echo
            if (input.length === 1 && input !== '\r' && input !== '\n') {
                const chunks: TokenChunk[] = [{
                    tokens: [input],
                    category: undefined
                }];
                await speakTokenList(chunks);
            }
        }
    };

    // Create and show terminal
    const terminal = vscode.window.createTerminal({ name: 'LipCoder', pty: ptyTerminal });
    terminal.show();
}

/**
 * Create fallback terminal
 */
function createFallbackTerminal(): void {
    logWarning('[Terminal] Creating fallback terminal');
    hasNodePty = false;
    
    terminalScreenLines = [];
    currentLineIndex = -1;

    fallbackTerminal = vscode.window.createTerminal({
        name: 'LipCoder Terminal (Fallback)',
        shellPath: process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL'],
        cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath
    });
    
    fallbackTerminal.show();
    
    vscode.window.showInformationMessage(
        'LipCoder Terminal: Fallback mode. Use "Add Terminal Output" to add content for navigation.',
        { modal: false }
    );
}

/**
 * Register terminal commands with simple navigation
 */
export function registerTerminalReader(context: ExtensionContext) {
    // Auto-open LipCoder terminal when other terminals close
    const terminalCloseListener = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
        if (closedTerminal.name !== 'LipCoder' && closedTerminal.name !== 'LipCoder Terminal (Fallback)') {
            await new Promise(resolve => setTimeout(resolve, 200));
            await vscode.commands.executeCommand('lipcoder.openTerminal');
            
            vscode.window.showInformationMessage('Terminal closed - LipCoder terminal opened', { modal: false });
            await speakTokenList([{ tokens: ['Terminal closed, LipCoder terminal opened'], category: undefined }]);
        }
    });
    
    context.subscriptions.push(terminalCloseListener);
    context.subscriptions.push(
        // Open LipCoder terminal
        vscode.commands.registerCommand('lipcoder.openTerminal', () => {
            let pty: any;
            try {
                pty = require('node-pty');
                createPtyTerminal(pty);
            } catch (err) {
                logError(`[Terminal] Failed to load node-pty: ${err}`);
                createFallbackTerminal();
            }
        }),

        // Read current terminal screen content
        vscode.commands.registerCommand('lipcoder.terminalReadHistory', async () => {
            if (terminalScreenLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Stop any previous reading immediately
            stopAllAudio();
            
            // Read last 5 screen lines
            const recentLines = terminalScreenLines.slice(-5);
            const screenText = recentLines.join(' ... ');
            
            const historyEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
            await playWave(historyEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            await speakTokenList([{ tokens: ['Terminal screen:', screenText], category: undefined }]);
        }),

        // Read last terminal line
        vscode.commands.registerCommand('lipcoder.terminalReadLast', async () => {
            if (terminalScreenLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content'], category: undefined }]);
                return;
            }
            
            // Stop any previous reading immediately
            stopAllAudio();
            const lastLine = terminalScreenLines[terminalScreenLines.length - 1];
            
            const lastEarcon = path.join(config.audioPath(), 'earcon', 'dot.pcm');
            await playWave(lastEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 50));
            await speakTokenList([{ tokens: [lastLine], category: undefined }]);
        }),

        // Navigate up through terminal screen lines
        vscode.commands.registerCommand('lipcoder.terminalHistoryUp', async () => {
            // IMMEDIATELY stop all audio at the very start
            stopAllAudio();
            
            logFeatureUsage('terminalHistoryUp', 'navigate');
            
            if (terminalScreenLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Initialize to last line if not set
            if (currentLineIndex < 0) {
                currentLineIndex = terminalScreenLines.length - 1;
            } else {
                const newIndex = currentLineIndex - 1;
                if (newIndex < 0) {
                    // Already at top, give feedback but don't read line again
                    const topEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                    await playWave(topEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await speakTokenList([{ tokens: ['Top of terminal buffer'], category: undefined }]);
                    return;
                }
                currentLineIndex = newIndex;
            }
            
            const line = terminalScreenLines[currentLineIndex];
            const lineNumber = currentLineIndex + 1;
            
            // Play navigation earcon
            const upEarcon = path.join(config.audioPath(), 'earcon', 'indent_1.pcm');
            await playWave(upEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            if (!line || line.trim().length === 0) {
                await speakTokenList([{ tokens: [`Line ${lineNumber}: empty`], category: undefined }]);
            } else {
                // Parse the terminal line into proper tokens with earcons
                const lineTokens = parseTerminalLineToTokens(line);
                const lineNumberChunk: TokenChunk = { tokens: [`Line ${lineNumber}:`], category: undefined };
                await speakTokenList([lineNumberChunk, ...lineTokens]);
            }
        }),

        // Navigate down through terminal screen lines
        vscode.commands.registerCommand('lipcoder.terminalHistoryDown', async () => {
            // IMMEDIATELY stop all audio at the very start
            stopAllAudio();
            
            logFeatureUsage('terminalHistoryDown', 'navigate');
            
            if (terminalScreenLines.length === 0) {
                await speakTokenList([{ tokens: ['No terminal content available'], category: undefined }]);
                return;
            }
            
            // Initialize to first line if not set
            if (currentLineIndex < 0) {
                currentLineIndex = 0;
            } else {
                const newIndex = currentLineIndex + 1;
                if (newIndex >= terminalScreenLines.length) {
                    // Already at bottom, give feedback
                    const bottomEarcon = path.join(config.audioPath(), 'earcon', 'enter2.pcm');
                    await playWave(bottomEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await speakTokenList([{ tokens: ['Bottom of terminal buffer'], category: undefined }]);
                    return;
                }
                currentLineIndex = newIndex;
            }
            
            const line = terminalScreenLines[currentLineIndex];
            const lineNumber = currentLineIndex + 1;
            
            // Play navigation earcon
            const downEarcon = path.join(config.audioPath(), 'earcon', 'indent_2.pcm');
            await playWave(downEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            if (!line || line.trim().length === 0) {
                await speakTokenList([{ tokens: [`Line ${lineNumber}: empty`], category: undefined }]);
            } else {
                // Parse the terminal line into proper tokens with earcons
                const lineTokens = parseTerminalLineToTokens(line);
                const lineNumberChunk: TokenChunk = { tokens: [`Line ${lineNumber}:`], category: undefined };
                await speakTokenList([lineNumberChunk, ...lineTokens]);
            }
        }),

        // Clear terminal screen buffer
        vscode.commands.registerCommand('lipcoder.terminalClearHistory', async () => {
            terminalScreenLines = [];
            terminalOutputBuffer = [];
            currentLineIndex = -1;
            
            const clearEarcon = path.join(config.audioPath(), 'earcon', 'backspace.pcm');
            await playWave(clearEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            await speakTokenList([{ tokens: ['Terminal buffer cleared'], category: undefined }]);
        }),

        // Capture current terminal content manually
        vscode.commands.registerCommand('lipcoder.captureTerminalOutput', async () => {
            const activeTerminal = vscode.window.activeTerminal;
            if (!activeTerminal) {
                await speakTokenList([{ tokens: ['No active terminal to capture'], category: undefined }]);
                return;
            }

            // Get clipboard content before and after selection
            const originalClipboard = await vscode.env.clipboard.readText();
            
            // Select all terminal content
            await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Copy to clipboard
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Get the copied content
            const terminalContent = await vscode.env.clipboard.readText();
            
            // Restore original clipboard
            await vscode.env.clipboard.writeText(originalClipboard);
            
            if (terminalContent && terminalContent !== originalClipboard) {
                // Clear existing buffer
                terminalScreenLines = [];
                terminalOutputBuffer = [];
                
                // Process the captured content
                const lines = terminalContent.split(/\r?\n/);
                for (const line of lines) {
                    const cleanLine = line
                        .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape sequences
                        .replace(/\u001b\]0;.*?\u0007/g, '') // Remove terminal title sequences
                        .replace(/\r/g, '') // Remove carriage returns
                        .trim();
                    
                    if (cleanLine.length > 0) {
                        terminalScreenLines.push(cleanLine);
                    }
                }
                
                // Set current position to the last line
                currentLineIndex = terminalScreenLines.length - 1;
                
                const captureEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
                await playWave(captureEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 100));
                await speakTokenList([{ 
                    tokens: [`Captured ${terminalScreenLines.length} lines from terminal. Use up/down to navigate.`], 
                    category: undefined 
                }]);
            } else {
                await speakTokenList([{ tokens: ['No terminal content captured'], category: undefined }]);
            }
        }),

        // Add manual output (for fallback mode)
        vscode.commands.registerCommand('lipcoder.addTerminalOutput', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter terminal output to add to screen buffer',
                placeHolder: 'Terminal output...'
            });
            
            if (input && input.trim()) {
                terminalScreenLines.push(input.trim());
                
                // Keep buffer size manageable
                if (terminalScreenLines.length > 50) {
                    terminalScreenLines = terminalScreenLines.slice(-30);
                }
                
                // Set current line to the newly added line
                currentLineIndex = terminalScreenLines.length - 1;
                
                const confirmEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
                await playWave(confirmEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 50));
                await speakTokenList([{ tokens: ['Added to terminal screen'], category: undefined }]);
            }
        }),

        // Quick setup for your terminal content
        vscode.commands.registerCommand('lipcoder.setupTerminalDemo', async () => {
            stopAllAudio();
            
            // Clear existing content
            terminalScreenLines = [];
            
            // Add the lines from your terminal screenshot in reverse order (bottom to top)
            const demoLines = [
                'gillosae@gimgillosaui-MacBookPro boost1 %',
                'npm start    # Run all university challenges', 
                'Usage:',
                'fetchUSUniversities function not implemented',
                'Problem 1: Fetching US universities...',
                '=== University API Challenge ===',
                'ts-node src/university.ts',
                '> boost1-university-search@1.0.0 start',
                'gillosae@gimgillosaui-MacBookPro boost1 % npm start'
            ];
            
            // Add lines to buffer
            terminalScreenLines.push(...demoLines);
            
            // Set current position to the bottom (prompt line)
            currentLineIndex = terminalScreenLines.length - 1;
            
            const confirmEarcon = path.join(config.audioPath(), 'earcon', 'enter.pcm');
            await playWave(confirmEarcon, { isEarcon: true, immediate: true }).catch(console.error);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            await speakTokenList([{ 
                tokens: [`Demo terminal content loaded. ${terminalScreenLines.length} lines ready. Use Up/Down to navigate.`], 
                category: undefined 
            }]);
        }),

        // Debug terminal state
        vscode.commands.registerCommand('lipcoder.debugTerminalState', async () => {
            stopAllAudio();
            
            const totalLines = terminalScreenLines.length;
            const currentPos = currentLineIndex + 1; // 1-based for user
            
            // Also log to console for debugging
            console.log('[Terminal Debug]', {
                totalLines,
                currentPos,
                terminalScreenLines,
                currentLineIndex
            });
            
            await speakTokenList([{ 
                tokens: [`Terminal has ${totalLines} lines, currently at line ${currentPos}`], 
                category: undefined 
            }]);
            
            // If no lines, suggest manual addition
            if (totalLines === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await speakTokenList([{ 
                    tokens: ['Use Add Terminal Output command to add content manually'], 
                    category: undefined 
                }]);
            }
        }),

        // Kill terminal and open LipCoder terminal
        vscode.commands.registerCommand('lipcoder.killTerminalAndOpenLipCoder', async () => {
            const activeTerminal = vscode.window.activeTerminal;
            
            if (activeTerminal) {
                activeTerminal.dispose();
                
                const killEarcon = path.join(config.audioPath(), 'earcon', 'backspace.pcm');
                await playWave(killEarcon, { isEarcon: true, immediate: true }).catch(console.error);
                
                await new Promise(resolve => setTimeout(resolve, 100));
                await vscode.commands.executeCommand('lipcoder.openTerminal');
                
                await speakTokenList([{ tokens: ['Terminal killed, LipCoder terminal opened'], category: undefined }]);
            } else {
                await vscode.commands.executeCommand('lipcoder.openTerminal');
                await speakTokenList([{ tokens: ['No active terminal, LipCoder terminal opened'], category: undefined }]);
            }
        })
    );
    
    // Register cleanup
    context.subscriptions.push({
        dispose: cleanupTerminalResources
    });
}