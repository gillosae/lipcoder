import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { getSpecialCharSpoken } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';
import { speakTokenList } from '../audio';
import { stopForNewLineReading, stopAllAudio, lineAbortController, setLineTokenReadingActive, getLineTokenReadingActive, getASRRecordingActive } from './stop_reading';
import { isEditorActive } from '../ide/active';
import { config } from '../config';
import { logFeatureUsage } from '../activity_logger';
import { shouldSuppressReadingEnhanced } from './debug_console_detection';

// Track the current execution to enable immediate cancellation
let currentReadLineTokensExecution: Promise<void> | null = null;
let isReadLineTokensRunning = false;

// Helper function to calculate panning based on column position
function calculatePanning(column: number): number {
    if (!config.globalPanningEnabled) {
        return 0; // No panning if disabled
    }
    
    // Map column 0-120 to panning -1.0 to +1.0
    // Columns beyond 120 will be clamped to +1.0
    const maxColumn = 120;
    const normalizedColumn = Math.min(column, maxColumn) / maxColumn;
    return (normalizedColumn * 2) - 1; // Convert 0-1 to -1 to +1
}

async function executeReadLineTokens(editor: vscode.TextEditor, client: LanguageClient): Promise<void> {
    try {
        // Check if we should suppress reading for debug console or other panels
        if (shouldSuppressReadingEnhanced(editor)) {
            log(`[readLineTokens] Suppressing reading for debug console or other panel`);
            return;
        }
        
        // Check if ASR is currently recording - if so, don't start token reading
        if (getASRRecordingActive()) {
            log(`[readLineTokens] ASR is recording - skipping token reading to avoid interference`);
            return;
        }
        
        isReadLineTokensRunning = true;
        
        // Set flag IMMEDIATELY to prevent interruption by inline suggestions
        // and to signal that we're starting line token reading
        setLineTokenReadingActive(true);
        log(`[readLineTokens] Line token reading flag set at start`);
        
        const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';

        // IMMEDIATELY stop any ongoing audio and controller - no delays  
        // Use centralized stopping system that handles everything
        stopForNewLineReading();
        
        const uri = editor.document.uri.toString();
        const line = editor.selection.active.line;
        const column = editor.selection.active.character;
        
        // Store the current line for race condition checking
        const originalLine = line;
        
        // Check if we were cancelled before starting LSP request
        if (lineAbortController.signal.aborted) {
            log(`[readLineTokens] Cancelled before LSP request`);
            return;
        }
        
        // Fetch tokens and categories from LSP
        let tokenData: { text: string; category: string }[];

        try {
            tokenData = await client.sendRequest('lipcoder/readLineTokens', { uri, line });
        } catch (err) {
            console.error('LSP request failed:', err);
            return;
        }
        
        // Check if we were cancelled during LSP request
        if (lineAbortController.signal.aborted) {
            log(`[readLineTokens] Cancelled after LSP request`);
            return;
        }
        
        // Check if cursor moved to a different line while we were waiting for LSP response
        const currentLine = editor.selection.active.line;
        if (currentLine !== originalLine) {
            log(`[readLineTokens] Cursor moved from line ${originalLine} to ${currentLine} during LSP request - aborting`);
            return;
        }
        
        // The abort controller signal is more reliable than the flag for detecting cancellation
        // The flag can be reset by other operations, but the abort signal is definitive
        
        log(`[readLineTokens] 👺👺👺👺👺  received ${tokenData.length} tokens: ${JSON.stringify(tokenData)}`);

        // Drop first chunk if it's only whitespace - be more careful about this
        if (tokenData.length > 0 && tokenData[0].text.trim() === '' && tokenData[0].category === 'other') {
            log(`[readLineTokens] Dropping initial whitespace token: "${tokenData[0].text}"`);
            tokenData = tokenData.slice(1);
        }

        // Remove every token whose text is only whitespace
        tokenData = tokenData.filter(token =>
            token.text.trim().length > 0
        );
    

        // Calculate panning for each token based on its column position
        const validChunks: { tokens: string[]; category: string; panning: number }[] = [];
        let currentColumn = 0; // Track column position as we iterate through tokens
        
        for (const { text, category } of tokenData) {
            const tokenPanning = calculatePanning(currentColumn);
            
            // Apply client-side categorization logic for unknown tokens
            let finalCategory = category;
            if (category === 'unknown') {
                // Single character - check if it should use specialCharMap (TTS) or earcons
                if (text.length === 1) {
                    if (getSpecialCharSpoken(text)) {
                        finalCategory = 'special'; // Will trigger TTS with specialCharMap
                    } else {
                        finalCategory = 'type'; // Will trigger earcon logic
                    }
                } else {
                    // Multi-character unknown tokens default to variable
                    finalCategory = 'variable';
                }
            }
            
            validChunks.push({ tokens: [text], category: finalCategory, panning: tokenPanning });
            
            // Update column position (simplified - assumes each character is one column)
            currentColumn += text.length;
        }

        // Check if we were cancelled during processing
        if (lineAbortController.signal.aborted) {
            log(`[readLineTokens] Cancelled during chunk processing`);
            return;
        }
        
        // DON'T call stopAllAudio() here - it creates a new controller and breaks the abort check
        // The stopForNewLineReading() call at line 40 already handled stopping

        // Create a flattened sequence for logging
        const flatTokens = validChunks.flatMap(chunk => chunk.tokens);
        const spokenSeq = flatTokens
            .map(tok => getSpecialCharSpoken(tok) ? `(${getSpecialCharSpoken(tok)})` : tok)
            .join(' ');
        log(`[readLineTokens]speak sequence: ${spokenSeq}`);

        try {
            // Final check before starting audio
            if (lineAbortController.signal.aborted) {
                log(`[readLineTokens] Cancelled before starting audio`);
                return;
            }
            
            // Final cursor position check to prevent race conditions
            const finalLine = editor.selection.active.line;
            if (finalLine !== originalLine) {
                log(`[readLineTokens] Cursor moved from line ${originalLine} to ${finalLine} before audio - aborting`);
                return;
            }
            
            // The abort controller and cursor position checks are sufficient
            // The flag check here was too aggressive and prevented legitimate audio
            
            await speakTokenList(validChunks, lineAbortController.signal);
            log(`[readLineTokens] Token sequence completed successfully`);
        } catch (err: any) {
            // Don't log errors if it was just an abort
            if (!lineAbortController.signal.aborted) {
                console.error('[readLineTokens] error:', err);
                log(`[readLineTokens] Token sequence failed with error: ${err}`);
            } else {
                log(`[readLineTokens] Token sequence aborted as expected`);
            }
        } finally {
            log(`[readLineTokens] Token reading completed`);
        }
    } finally {
        isReadLineTokensRunning = false;
        // Always clear the line reading flag when function exits
        setLineTokenReadingActive(false);
        log(`[readLineTokens] Line token reading flag cleared on function exit`);
        if (currentReadLineTokensExecution === currentReadLineTokensExecution) {
            currentReadLineTokensExecution = null;
        }
    }
}

export function registerReadLineTokens(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readLineTokens', async (editorArg?: vscode.TextEditor) => {
            const editor = isEditorActive(editorArg);
            if (!editor) return;

            logFeatureUsage('read_line_tokens', 'command_executed', {
                file: editor.document.fileName,
                line: editor.selection.active.line,
                character: editor.selection.active.character,
                languageId: editor.document.languageId
            });

            // Check if ASR is currently recording - if so, don't start token reading
            if (getASRRecordingActive()) {
                log(`[readLineTokens] Command called but ASR is recording - ignoring to avoid interference`);
                return;
            }

            // IMMEDIATELY cancel any ongoing execution
            if (currentReadLineTokensExecution) {
                log(`[readLineTokens] Cancelling previous execution`);
                stopAllAudio(); // This aborts the current lineAbortController through centralized system
                
                // Wait a very brief moment for the cancellation to be processed
                try {
                    await Promise.race([
                        currentReadLineTokensExecution,
                        new Promise(resolve => setTimeout(resolve, 5)) // Max 5ms wait
                    ]);
                } catch (err) {
                    // Ignore errors from cancelled execution
                }
            }

            // Start new execution immediately
            currentReadLineTokensExecution = executeReadLineTokens(editor, client);
            
            try {
                await currentReadLineTokensExecution;
            } catch (err) {
                console.error('[readLineTokens] Execution failed:', err);
            } finally {
                // Clear the current execution reference
                currentReadLineTokensExecution = null;
            }
        })
    );
}