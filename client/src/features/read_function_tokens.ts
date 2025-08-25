import { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { log } from '../utils';
import { speakTokenList } from '../audio';
import { stopAllAudio } from './stop_reading';
import { config } from '../config';
import { shouldSuppressReadingEnhanced } from './debug_console_detection';

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

export function registerReadFunctionTokens(
    context: ExtensionContext,
    client: LanguageClient,
) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readFunctionTokens', async (editorArg?: vscode.TextEditor) => {
            try {
                const { isEditorActive } = require('../ide/active');
                const editor = editorArg ?? isEditorActive();
                if (!editor) {
                    vscode.window.setStatusBarMessage('No active file editor - please open a code file', 3000);
                    return;
                }
                
                // Check if we should suppress reading for debug console or other panels
                if (shouldSuppressReadingEnhanced(editor)) {
                    log(`[readFunctionTokens] Suppressing reading for debug console or other panel`);
                    return;
                }
                // Stop any ongoing audio
                stopAllAudio();

                const uri = editor.document.uri.toString();
                const position = editor.selection.active;
                
                // Calculate panning based on cursor column position
                const panning = calculatePanning(position.character);
                
                log(`[readFunctionTokens] invoked for ${uri} at line ${position.line}, char ${position.character}`);

                // Request tokens for the current function from the LSP
                let tokData: { text: string; category: string }[];
                try {
                    tokData = await client.sendRequest('lipcoder/readFunctionTokens', { uri, position });
                } catch (err) {
                    console.error('LSP request failed:', err);
                    return;
                }
                log(`[readFunctionTokens] received ${tokData.length} tokens`);

                // Speak each token in sequence with panning
                for (const { text, category } of tokData) {
                    if (text.trim() === '') continue;
                    await speakTokenList([{ tokens: [text], category, panning }]);
                }
            } catch (err: any) {
                console.error('readFunctionTokens error:', err);
            }
        })
    );
}