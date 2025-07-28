import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { specialCharMap } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';
import { splitWordChunks, splitCommentChunks } from './word_logic';
import { speakTokenList } from '../audio';
import { stopReading, lineAbortController, setLineTokenReadingActive, getLineTokenReadingActive } from './stop_reading';
import { isEditorActive } from '../ide/active';
import { config } from '../config';

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

export function registerReadLineTokens(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readLineTokens', async (editorArg?: vscode.TextEditor) => {
            const editor = isEditorActive(editorArg);
            if (!editor) return;

            const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';

            // Global stop: abort any ongoing audio and controller
            stopReading();

            const uri = editor.document.uri.toString();
            const line = editor.selection.active.line;
            const column = editor.selection.active.character;
            
            // Fetch tokens and categories from LSP
            let tokenData: { text: string; category: string }[];

            try {
                tokenData = await client.sendRequest('lipcoder/readLineTokens', { uri, line });
            } catch (err) {
                console.error('LSP request failed:', err);
                return;
            }
            log(`[readLineTokens] received ${tokenData.length} tokens: ${JSON.stringify(tokenData)}`);

            // Drop first chunk if it's only whitespace
            if (tokenData.length > 0 && tokenData[0].text.trim() === '') {
                tokenData = tokenData.slice(1);
            }

            // Calculate panning for each token based on its column position
            const validChunks: { tokens: string[]; category: string; panning: number }[] = [];
            let currentColumn = 0; // Track column position as we iterate through tokens
            
            for (const { text, category } of tokenData) {
                const tokenPanning = calculatePanning(currentColumn);
                
                // Use special comment chunking for comment-related tokens
                const isCommentToken = category.startsWith('comment_') || category === 'comment';
                const chunks = isCommentToken ? splitCommentChunks(text, category) : splitWordChunks(text);
                
                validChunks.push({
                    tokens: chunks,
                    category,
                    panning: tokenPanning
                });
                
                // Update column position for next token
                currentColumn += text.length;
            }
            // log(`[readLineTokens] split chunks: ${JSON.stringify(validChunks)}`);

            // Log the upcoming audio tokens in human‐readable form
            const flatTokens = validChunks.flatMap(({ tokens }) => tokens);
            const spokenSeq = flatTokens
                .map(tok => specialCharMap[tok] ? `(${specialCharMap[tok]})` : tok)
                .join(' ');
            log(`[readLineTokens] speak sequence: ${spokenSeq}`);

            try {
                // Set flag to prevent interruption by other features (but allow cursor movement)
                setLineTokenReadingActive(true);
                log(`[readLineTokens] Line token reading flag set, starting token sequence`);
                await speakTokenList(validChunks, lineAbortController.signal);
                log(`[readLineTokens] Token sequence completed successfully`);
            } catch (err: any) {
                console.error('[readLineTokens] error:', err);
                log(`[readLineTokens] Token sequence failed with error: ${err}`);
            } finally {
                // Always clear the flag when done
                setLineTokenReadingActive(false);
                log(`[readLineTokens] Line token reading flag cleared`);
            }
        })
    );
}