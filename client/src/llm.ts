import { stopPlayback, playEarcon, speakToken, playWave } from './audio';
import * as path from 'path';
import { log } from './utils';
import * as vscode from 'vscode';
import { registerInlineSuggestions } from './features/inline_suggestions';
import OpenAI from 'openai';

export interface SuggestionState {
    line: number;
    suggestion: string;
    read: boolean;
}

export let lastSuggestion: SuggestionState | null = null;

/**
 * Clears the stored suggestion.
 */
export function clearLastSuggestion(): void {
    lastSuggestion = null;
}

/**
 * Returns true if the given line number is suppressed.
 */
export function isLineSuppressed(line: number): boolean {
    return suppressedLines.has(line);
}

/**
 * Store the last suggestion state.
 */
export function setLastSuggestion(state: SuggestionState | null): void {
    lastSuggestion = state;
}

/**
 * Marks the current suggestion as read.
 */
export function markSuggestionRead(): void {
    if (lastSuggestion) lastSuggestion.read = true;
}

/**
 * Remove Markdown code fences (```language\n ... ```), returning only the inner code.
 */
export function stripFences(text: string): string {
    return text
        .replace(/^```(?:\w+)?\r?\n?/, '')  // remove opening fence
        .replace(/```$/, '')               // remove closing fence
        .trim();
}

// Track lines for which suggestions were rejected
const suppressedLines = new Set<number>();
export function suppressLine(line: number) {
    suppressedLines.add(line);
}

// Initialize OpenAI client using the user's API key from settings or env
export function getOpenAIClient(): OpenAI {
    const config = vscode.workspace.getConfiguration('lipcoder');
    let apiKey = config.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        vscode.window.showErrorMessage('OpenAI API key not set. Please set lipcoder.openaiApiKey in settings or OPENAI_API_KEY env var.');
        throw new Error('Missing OpenAI API key');
    }
    return new OpenAI({ apiKey });
}


/**
 * Delegate chat completions to the inline suggestions module.
 */
export function registerChatCompletions(context: vscode.ExtensionContext) {
    registerInlineSuggestions(context);
}


/**
 * Suggests code continuation for the given line via OpenAI.
 */
export async function suggestCodeContinuation(line: string): Promise<string> {
    const client = getOpenAIClient();
    // Log what is being sent
    log(`OpenAI Continuation Sent: ${line}`);
    const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: "You are a code autocomplete assistant. Only output the code completion snippet without any explanation or commentary." },
            { role: "user", content: `Complete this code line:\n${line}` }
        ],
        max_tokens: 64,
        temperature: 0.2
    });
    let suggestion = resp.choices[0]?.message?.content?.trim() || "";
    suggestion = stripFences(suggestion);
    // Remove duplicate prefix if the suggestion repeats the existing code, ignoring indent
    const indentMatch = line.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : '';
    const trimmedLine = line.trimStart();
    const trimmedSuggestion = suggestion.trimStart();
    if (trimmedSuggestion.startsWith(trimmedLine)) {
        const startIdx = suggestion.indexOf(trimmedLine);
        suggestion = suggestion.slice(startIdx + trimmedLine.length);
    }
    suggestion = suggestion.trimStart();
    // Log what was received
    log(`OpenAI Continuation Received: ${suggestion}`);
    return suggestion;
}
