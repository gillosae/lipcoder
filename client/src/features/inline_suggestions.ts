import * as vscode from 'vscode';
import { InlineCompletionItem, InlineCompletionItemProvider, InlineCompletionContext, InlineCompletionTriggerKind } from 'vscode';
import { getOpenAIClient, stripFences, isLineSuppressed, lastSuggestion, clearLastSuggestion, setLastSuggestion } from '../llm';

import { stopPlayback, playWave, speakToken } from '../audio';
import * as path from 'path';
import { log } from '../utils';

import { config } from '../config';

// Idle-based inline suggestion trigger state
let idleTimer: NodeJS.Timeout | null = null;
let suggestionInvoked = false;

/**
 * Register inline suggestion provider and related commands.
 */
export function registerInlineSuggestions(context: vscode.ExtensionContext) {
    const client = getOpenAIClient();

    // Trigger inline suggest after 5s of cursor idle
    vscode.window.onDidChangeTextEditorSelection(event => {
        suggestionInvoked = false;
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
            if (!suggestionInvoked) {
                vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
                suggestionInvoked = true;
            }
        }, 5000);
    }, null, context.subscriptions);

    const provider: InlineCompletionItemProvider = {
        async provideInlineCompletionItems(document, position, context: InlineCompletionContext) {
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

            log(`Inline prompt: ${userPrompt}`);

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
            const item = new InlineCompletionItem(newText);
            item.range = new vscode.Range(start, end);

            console.log('audioPath →', config.audioPath());
            // Play visual alert earcon using config.audioPath()
            const alertWav = path.join(config.audioPath(), 'alert', 'suggestion.wav');
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
            stopPlayback();
            if (!lastSuggestion.read) {
                5
                await speakToken(lastSuggestion.suggestion);
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
}