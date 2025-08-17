import { stopPlayback, playEarcon, speakToken, playWave } from './audio';
import * as path from 'path';
import { log, logWarning, logSuccess } from './utils';
import * as vscode from 'vscode';
import { registerInlineSuggestions } from './features/inline_suggestions';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { currentLLMBackend, LLMBackend, claudeConfig } from './config';

export interface SuggestionState {
    line: number;
    suggestion: string;
    read: boolean;
}

export let lastSuggestion: SuggestionState | null = null;

// Cache OpenAI client to prevent memory leaks from multiple instances
let cachedOpenAIClient: OpenAI | null = null;

// Cache Claude client to prevent memory leaks from multiple instances
let cachedClaudeClient: Anthropic | null = null;

/**
 * Clears the stored suggestion.
 */
export function clearLastSuggestion(): void {
    lastSuggestion = null;
}

/**
 * Clean up LLM resources
 */
export function cleanupLLMResources(): void {
    lastSuggestion = null;
    cachedOpenAIClient = null;
    cachedClaudeClient = null;
    suppressedLines.clear();
    logSuccess('[LLM] Cleaned up resources');
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
    // Return cached client if available and config hasn't changed
    if (cachedOpenAIClient) {
        return cachedOpenAIClient;
    }
    
    const config = vscode.workspace.getConfiguration('lipcoder');
    let apiKey = config.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        vscode.window.showErrorMessage('OpenAI API key not set. Please set lipcoder.openaiApiKey in settings or OPENAI_API_KEY env var.');
        throw new Error('Missing OpenAI API key');
    }
    
    cachedOpenAIClient = new OpenAI({ apiKey });
    return cachedOpenAIClient;
}

// Initialize Claude client using the user's API key from settings or env
export function getClaudeClient(): Anthropic {
    // Return cached client if available and config hasn't changed
    if (cachedClaudeClient) {
        return cachedClaudeClient;
    }
    
    const config = vscode.workspace.getConfiguration('lipcoder');
    let apiKey = config.get<string>('claudeApiKey') || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        vscode.window.showErrorMessage('Claude API key not set. Please set lipcoder.claudeApiKey in settings or ANTHROPIC_API_KEY env var.');
        throw new Error('Missing Claude API key');
    }
    
    cachedClaudeClient = new Anthropic({ apiKey });
    return cachedClaudeClient;
}


/**
 * Delegate chat completions to the inline suggestions module.
 */
export function registerChatCompletions(context: vscode.ExtensionContext) {
    registerInlineSuggestions(context);
}


/**
 * Generic LLM completion function that uses the configured backend
 */
export async function callLLMForCompletion(
    systemPrompt: string, 
    userPrompt: string, 
    maxTokens: number = 64, 
    temperature: number = 0.2
): Promise<string> {
    // CRITICAL: Block ALL LLM completion requests during line reading
    const { getLineTokenReadingActive } = await import('./features/stop_reading.js');
    if (getLineTokenReadingActive()) {
        log(`[LLM] BLOCKING completion request during line token reading`);
        return ''; // Return empty string to prevent any suggestions
    }
    
    try {
        if (currentLLMBackend === LLMBackend.Claude) {
            const client = getClaudeClient();
            log(`[LLM] Claude Sent: ${userPrompt.substring(0, 200)}...`);
            
            const response = await client.messages.create({
                model: claudeConfig.model,
                max_tokens: maxTokens,
                temperature: temperature,
                messages: [
                    { role: "user", content: `${systemPrompt}\n\n${userPrompt}` }
                ]
            });
            
            const content = response.content[0];
            let result = '';
            if (content.type === 'text') {
                result = content.text.trim();
            }
            
            log(`[LLM] Claude Received: ${result.substring(0, 200)}...`);
            return result;
        } else {
            // Default to ChatGPT
            const client = getOpenAIClient();
            log(`[LLM] OpenAI Sent: ${userPrompt.substring(0, 200)}...`);
            
            const response = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                max_tokens: maxTokens,
                temperature: temperature
            });
            
            const result = response.choices[0]?.message?.content?.trim() || '';
            log(`[LLM] OpenAI Received: ${result.substring(0, 200)}...`);
            return result;
        }
    } catch (error) {
        log(`[LLM] Error with ${currentLLMBackend}: ${error}`);
        throw new Error(`Failed to get completion from ${currentLLMBackend}: ${error}`);
    }
}

/**
 * Suggests code continuation for the given line via configured LLM.
 */
export async function suggestCodeContinuation(line: string): Promise<string> {
    const systemPrompt = "You are a code autocomplete assistant. Only output the code completion snippet without any explanation or commentary.";
    const userPrompt = `Complete this code line:\n${line}`;
    
    let suggestion = await callLLMForCompletion(systemPrompt, userPrompt, 64, 0.2);
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
    
    return suggestion;
}

