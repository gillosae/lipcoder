import { speakTokenList, TokenChunk } from '../audio';
import type { ExtensionContext } from 'vscode';
import { lineAbortController } from './stop_reading';
import * as vscode from 'vscode';
import { numberMap } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';
import { log, logSuccess } from '../utils';
import { shouldSuppressReadingEnhanced } from './debug_console_detection';

/**
 * Clean up current line resources
 */
function cleanupCurrentLine(): void {
    logSuccess('[CurrentLine] Cleaned up resources');
}

// Track last preloaded line to avoid repeated spawns
let lastPreloadedLine: number | undefined;

export function registerCurrentLine(context: ExtensionContext) {
    // Track the event listener for proper disposal
    const selectionListener = vscode.window.onDidChangeTextEditorSelection(async e => {
        // Check if we should suppress reading for debug console or other panels
        if (shouldSuppressReadingEnhanced(e.textEditor)) {
            return;
        }
        
        // Note: Preloading is now handled automatically by speakTokenList when needed
        // This listener could be removed if preloading is no longer required
    });
    
    context.subscriptions.push(selectionListener);
    
    // Register cleanup disposal
    context.subscriptions.push({
        dispose: cleanupCurrentLine
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readCurrentLine', async (editorArg?: vscode.TextEditor) => {
            const editor = editorArg || vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor!');
                return;
            }

            const lineNum = editor.selection.active.line + 1; // zero-based → human count
            // Just read the current line content without announcing line number
            const line = editor.document.lineAt(editor.selection.active.line);
            const tokens = line.text.trim() ? [line.text] : ['blank'];
            
            // Convert tokens to speakable form and create chunks
            const chunks: TokenChunk[] = tokens.map(token => {
                // If the token is purely digits and exists in our map, use the word form
                const toSpeak = /^\d+$/.test(token) && numberMap[token]
                    ? numberMap[token]
                    : token;
                return {
                    tokens: [toSpeak],
                    category: 'literal'
                };
            });
            
            await speakTokenList(chunks, lineAbortController.signal);
        })
    );
}