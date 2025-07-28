import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { specialCharMap } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';
import { speakTokenList } from '../audio';
import { stopForNewLineReading, stopAllAudio, lineAbortController, setLineTokenReadingActive, getLineTokenReadingActive } from './stop_reading';
import { isEditorActive } from '../ide/active';
import { config } from '../config';

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
        isReadLineTokensRunning = true;
        const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';

        // IMMEDIATELY stop any ongoing audio and controller - no delays  
        // Use centralized stopping system that handles everything
        stopForNewLineReading();
        
        const uri = editor.document.uri.toString();
        const line = editor.selection.active.line;
        const column = editor.selection.active.character;
        
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
            
            // Keep all tokens as single tokens - word logic is now applied universally in speakTokenList
            validChunks.push({ tokens: [text], category, panning: tokenPanning });
            
            // Update column position (simplified - assumes each character is one column)
            currentColumn += text.length;
        }

        // Check if we were cancelled during processing
        if (lineAbortController.signal.aborted) {
            log(`[readLineTokens] Cancelled during chunk processing`);
            return;
        }
        
        // Additional safety: stop any residual audio right before starting new audio
        stopAllAudio();

        // Create a flattened sequence for logging
        const flatTokens = validChunks.flatMap(chunk => chunk.tokens);
        const spokenSeq = flatTokens
            .map(tok => specialCharMap[tok] ? `(${specialCharMap[tok]})` : tok)
            .join(' ');
        log(`[readLineTokens]speak sequence: ${spokenSeq}`);

        try {
            // Set flag to prevent interruption by other features (but allow cursor movement)
            setLineTokenReadingActive(true);
            log(`[readLineTokens] Line token reading flag set, starting token sequence`);
            
            // Final check before starting audio
            if (lineAbortController.signal.aborted) {
                log(`[readLineTokens] Cancelled before starting audio`);
                return;
            }
            
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
            // Always clear the flag when done
            setLineTokenReadingActive(false);
            log(`[readLineTokens] Line token reading flag cleared`);
        }
    } finally {
        isReadLineTokensRunning = false;
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