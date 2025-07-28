import * as vscode from 'vscode';
import * as path from 'path';

import { InlineCompletionItem, InlineCompletionItemProvider, InlineCompletionContext, InlineCompletionTriggerKind } from 'vscode';
import { getOpenAIClient, stripFences, isLineSuppressed, lastSuggestion, clearLastSuggestion, setLastSuggestion, markSuggestionRead } from '../llm';
import { playWave, speakTokenList, TokenChunk, playEarcon } from '../audio';
import { stopAllAudio, getLineTokenReadingActive } from './stop_reading';
import { log } from '../utils';
import { config } from '../config';

// Idle-based inline suggestion trigger state
let idleTimer: NodeJS.Timeout | null = null;
let suggestionInvoked = false;

/**
 * Clean up inline suggestions resources
 */
function cleanupInlineSuggestions(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    suggestionInvoked = false;
    log('[InlineSuggestions] Cleaned up resources');
}

/**
 * Register inline suggestion provider and related commands.
 */
export function registerInlineSuggestions(context: vscode.ExtensionContext) {
    const client = getOpenAIClient();

    // Trigger inline suggest after 5s of cursor idle
    const selectionListener = vscode.window.onDidChangeTextEditorSelection(event => {
        suggestionInvoked = false;
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
            // Don't trigger suggestions if line token reading is active
            if (getLineTokenReadingActive()) {
                log(`[InlineSuggestions] Skipping idle trigger during line token reading`);
                return;
            }
            
            if (!suggestionInvoked) {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
                suggestionInvoked = true;
            }
        }, 5000);
    });
    
    context.subscriptions.push(selectionListener);

    const provider: InlineCompletionItemProvider = {
        async provideInlineCompletionItems(document, position, context: InlineCompletionContext) {
            // Don't run inline suggestions during line token reading
            if (getLineTokenReadingActive()) {
                log(`[InlineSuggestions] Skipping suggestion generation during line token reading`);
                return { items: [] };
            }
            
            // Only allow after manual invoke or our idle trigger
            if (!suggestionInvoked && context.triggerKind !== InlineCompletionTriggerKind.Invoke) {
                return { items: [] };
            }
            // Skip suppressed lines
            if (isLineSuppressed(position.line)) {
                return { items: [] };
            }
            // Build context: last up to 500 lines
            const allText = document.getText();
            const lines = allText.split('\n');
            const recent = lines.length > 500 ? lines.slice(lines.length - 500) : lines;
            const contextText = recent.join('\n');
            const currentLine = position.line + 1;
            const userPrompt =
                `Provide only an inline code suggestion (no explanation). ` +
                `Return only the code to insert at the current cursor position in line ${currentLine}, ` +
                `given the following context:\n${contextText}`;

            // log(`Inline prompt: ${userPrompt}`);

            const resp = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are a code autocomplete assistant. Only output the code snippet without explanation." },
                    { role: "user", content: userPrompt }
                ],
                max_tokens: 64,
                temperature: 0.2
            });

            let suggestion = resp.choices[0]?.message?.content || '';
            suggestion = stripFences(suggestion).trim();
            if (!suggestion || /^(sure|please|here|okay|ok)[,\s]/i.test(suggestion)) {
                return { items: [] };
            }

            log(`Suggestion: ${suggestion}`);

            // Create the inline completion item
            const prefix = document.lineAt(position.line).text.match(/^[ \t]*/)?.[0] || '';
            const newText = prefix + suggestion;
            const start = new vscode.Position(position.line, 0);
            const end = document.lineAt(position.line).range.end;
            const item = new InlineCompletionItem(
                newText,
                new vscode.Range(start, end)
            );
            item.range = new vscode.Range(start, end);

            console.log('audioPath →', config.audioPath());
            // Play visual alert earcon using config.audioPath()
            const alertWav = path.join(config.audioPath(), 'alert', 'suggestion.pcm');
            
            // This should not run during line token reading anymore
            stopAllAudio(); // Use centralized stopping that includes clearing audio state
            playWave(alertWav, { immediate: true }).catch(console.error);

            // Store for two-step accept
            setLastSuggestion({ line: position.line, suggestion, read: false });

            return { items: [item] };
        }
    };

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*.{js,ts,py}' }, provider)
    );

    // Command: read or apply suggestion on Shift+Enter
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.handleSuggestionKey', async () => {
            if (!lastSuggestion) return;
            
            // Only stop reading if line token reading is not currently active
            if (!getLineTokenReadingActive()) {
                stopAllAudio(); // Use centralized stopping that includes clearing audio state
            }
            
            if (!lastSuggestion.read) {
                await speakTokenList([{ tokens: [lastSuggestion.suggestion], category: undefined }]);
                lastSuggestion.read = true;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const { line, suggestion } = lastSuggestion;
                    const start = new vscode.Position(line, 0);
                    const end = editor.document.lineAt(line).range.end;
                    await editor.edit(b => b.replace(new vscode.Range(start, end), suggestion));
                }
                clearLastSuggestion();
            }
        })
    );

    // Command: cancel suggestion on Backspace
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.cancelSuggestion', () => {
            clearLastSuggestion();
        })
    );

    // Commands: accept or reject suggestions via Shift+Enter / Backspace
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.acceptSuggestion', async () => {
            const editor = vscode.window.activeTextEditor;
            if (
                editor &&
                lastSuggestion &&
                editor.selection.active.line === lastSuggestion.line &&
                !lastSuggestion.read
            ) {
                // First Shift+Enter: stop any ongoing audio, then play alert beep and read suggestion
                // Only stop reading if line token reading is not currently active
                if (!getLineTokenReadingActive()) {
                    stopAllAudio(); // Use centralized stopping system
                }
                
                playEarcon('client/audio/alert/suggestion.pcm', 0); // Center panning for alert
                await speakTokenList([{ tokens: [lastSuggestion.suggestion], category: undefined }]);
                markSuggestionRead();
            } else {
                // Second Shift+Enter: accept suggestion
                await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
                clearLastSuggestion();
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.rejectSuggestion', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && lastSuggestion && editor.selection.active.line === lastSuggestion.line) {
                await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
                clearLastSuggestion();
            }
        })
    );

    // Register context cleanup  
    context.subscriptions.push({ dispose: cleanupInlineSuggestions });
}