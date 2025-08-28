import * as vscode from 'vscode';
import { log } from '../utils';
import { ConversationalAction } from '../conversational_asr';
import { speakTokenList, TokenChunk } from '../audio';
import { stopAllAudio } from './stop_reading';
import * as path from 'path';

// TTS navigation control (debounce + cancel)
let ttsDebounceTimer: NodeJS.Timeout | null = null;
let ttsSpeakSeq = 0; // monotonic id to cancel stale speak calls
let lastSpokenKey: string | null = null; // avoid repeating same utterance
const TTS_DEBOUNCE_MS = 140; // slight delay to coalesce fast focus changes

export interface SavedSuggestion {
    id: string;
    timestamp: number;
    originalCommand: string;
    suggestions: ConversationalAction[];
    context?: {
        fileName?: string;
        lineNumber?: number;
        selectedText?: string;
    };
}

// Global storage for saved suggestions
let savedSuggestions: Map<string, SavedSuggestion> = new Map();
let currentSuggestionId: string | null = null;

// TTS helper for suggestions (cancel-safe)
async function speakNow(text: string): Promise<void> {
    try {
        const mySeq = ++ttsSpeakSeq;
        // Ensure any ongoing audio stops before starting a new one
        await Promise.resolve(stopAllAudio());
        const chunks: TokenChunk[] = [{ tokens: [text], category: undefined }];
        // If another speak started meanwhile, drop this one
        if (mySeq !== ttsSpeakSeq) return;
        await speakTokenList(chunks);
    } catch (e) {
        log(`[SuggestionStorage] TTS failed: ${e}`);
    }
}

function speakDebounced(text: string, key?: string): void {
    // Skip if same message as last time
    if (key && lastSpokenKey === key) return;
    
    // Immediately stop any current audio to prevent overlap
    void Promise.resolve(stopAllAudio());
    
    if (ttsDebounceTimer) clearTimeout(ttsDebounceTimer);
    ttsDebounceTimer = setTimeout(() => {
        lastSpokenKey = key || text;
        void speakNow(text);
    }, TTS_DEBOUNCE_MS);
}

function resetTTSState(): void {
    if (ttsDebounceTimer) { clearTimeout(ttsDebounceTimer); ttsDebounceTimer = null; }
    lastSpokenKey = null;
    ttsSpeakSeq++; // invalidate any pending speakNow
    void Promise.resolve(stopAllAudio());
}

/**
 * Save suggestions instead of executing them immediately
 */
export function saveSuggestions(
    originalCommand: string, 
    suggestions: ConversationalAction[], 
    context?: SavedSuggestion['context']
): string {
    const id = `suggestion_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const savedSuggestion: SavedSuggestion = {
        id,
        timestamp: Date.now(),
        originalCommand,
        suggestions,
        context
    };
    
    savedSuggestions.set(id, savedSuggestion);
    currentSuggestionId = id;
    
    log(`[SuggestionStorage] Saved ${suggestions.length} suggestions for command: "${originalCommand}"`);
    log(`[SuggestionStorage] Suggestion ID: ${id}`);
    
    // Show non-blocking notification about saved suggestions
    const suggestionCount = suggestions.length;
    const message = `💡 ${suggestionCount} suggestion${suggestionCount > 1 ? 's' : ''} saved. Say "continue" or use Command Palette → "Continue with Suggestions"`;
    
    vscode.window.showInformationMessage(message, { modal: false });
    
    return id;
}

/**
 * Get the current saved suggestions
 */
export function getCurrentSuggestions(): SavedSuggestion | null {
    if (!currentSuggestionId) {
        return null;
    }
    
    return savedSuggestions.get(currentSuggestionId) || null;
}

/**
 * Get saved suggestions by ID
 */
export function getSavedSuggestions(id: string): SavedSuggestion | null {
    return savedSuggestions.get(id) || null;
}

/**
 * Clear current suggestions
 */
export function clearCurrentSuggestions(): void {
    if (currentSuggestionId) {
        savedSuggestions.delete(currentSuggestionId);
        log(`[SuggestionStorage] Cleared current suggestions: ${currentSuggestionId}`);
        currentSuggestionId = null;
    }
}

/**
 * Clear all saved suggestions
 */
export function clearAllSuggestions(): void {
    const count = savedSuggestions.size;
    savedSuggestions.clear();
    currentSuggestionId = null;
    log(`[SuggestionStorage] Cleared all ${count} saved suggestions`);
}

/**
 * Get all saved suggestions (for debugging/management)
 */
export function getAllSavedSuggestions(): SavedSuggestion[] {
    return Array.from(savedSuggestions.values()).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Check if there are any current suggestions available
 */
export function hasCurrentSuggestions(): boolean {
    return currentSuggestionId !== null && savedSuggestions.has(currentSuggestionId);
}

/**
 * Show the current suggestions in a quick pick menu with audio navigation
 */
export async function showCurrentSuggestions(): Promise<ConversationalAction | null> {
    const current = getCurrentSuggestions();
    if (!current) {
        vscode.window.showInformationMessage('No saved suggestions available. Use ASR commands to generate suggestions first.');
        return null;
    }

    log(`[SuggestionStorage] Showing ${current.suggestions.length} suggestions for: "${current.originalCommand}"`);

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `Continue with Suggestions (${current.originalCommand})`;
    quickPick.placeholder = 'Select a suggestion to execute...';
    quickPick.canSelectMany = false;
    quickPick.ignoreFocusOut = true;

    interface SuggestionQuickPickItem extends vscode.QuickPickItem {
        suggestion: ConversationalAction;
        index: number;
    }

    const items: SuggestionQuickPickItem[] = current.suggestions.map((suggestion, index) => ({
        label: `$(lightbulb) ${suggestion.label}`,
        description: suggestion.description || '',
        detail: suggestion.type ? `Type: ${suggestion.type}` : undefined,
        suggestion,
        index
    }));

    quickPick.items = items;

    // Set initial active item and speak summary
    if (items.length > 0) {
        quickPick.activeItems = [items[0]];
        const first = items[0];
        const base = current.context?.fileName ? path.basename(current.context.fileName) : '';
        const ctx = base ? ` in ${base}` : '';
        speakDebounced(
            `${items.length} suggestions${ctx}. Selected: ${first.label}. ${first.description || ''}`,
            `summary:${current.id}:${first.index}`
        );
    } else {
        speakDebounced('No suggestions to select.', 'summary:none');
    }

    return new Promise((resolve) => {
        quickPick.onDidChangeActive((actives) => {
            const a = actives && actives[0] as SuggestionQuickPickItem;
            if (a) {
                // Immediately stop current speech before speaking new suggestion
                resetTTSState();
                speakDebounced(
                    `${a.label}. ${a.description || ''}`,
                    `active:${current.id}:${a.index}`
                );
            }
        });

        quickPick.onDidChangeSelection((selection) => {
            const s = selection && selection[0] as SuggestionQuickPickItem;
            if (s) {
                // Immediately stop current speech before speaking selection
                resetTTSState();
                speakDebounced(
                    `Chosen: ${s.label}. Press Enter to execute.`,
                    `select:${current.id}:${s.index}`
                );
            }
        });

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0] as SuggestionQuickPickItem;
            if (selected && selected.suggestion) {
                log(`[SuggestionStorage] User selected suggestion: "${selected.suggestion.label}"`);
                resolve(selected.suggestion);
            } else {
                resolve(null);
            }
            quickPick.dispose();
        });

        quickPick.onDidHide(() => {
            resetTTSState();
            resolve(null);
            quickPick.dispose();
        });

        quickPick.show();
    });
}

/**
 * Show all saved suggestion sets with audio navigation.
 */
export async function showSuggestionHistory(): Promise<SavedSuggestion | null> {
    const all = getAllSavedSuggestions();
    if (all.length === 0) {
        vscode.window.showInformationMessage('No saved suggestion sets available.');
        return null;
    }

    interface HistoryItem extends vscode.QuickPickItem {
        saved: SavedSuggestion;
    }

    const items: HistoryItem[] = all.map((s) => {
        const base = s.context?.fileName ? path.basename(s.context.fileName) : undefined;
        return {
            label: `$(history) ${new Date(s.timestamp).toLocaleTimeString()} — ${s.originalCommand}`,
            description: `${s.suggestions.length} suggestion${s.suggestions.length > 1 ? 's' : ''}`,
            detail: base ? `File: ${base}${s.context?.lineNumber ? `, Line ${s.context.lineNumber}` : ''}` : undefined,
            saved: s
        } as HistoryItem;
    });

    const qp = vscode.window.createQuickPick<HistoryItem>();
    qp.title = 'Suggestion History';
    qp.placeholder = 'Pick a suggestion set…';
    qp.items = items;
    qp.ignoreFocusOut = true;

    // Speak summary and first item
    if (items.length > 0) {
        qp.activeItems = [items[0]];
        const first = items[0];
        speakDebounced(
            `${items.length} suggestion sets. Selected: ${first.label}. ${first.description}`,
            `hist:summary:${first.label}`
        );
    }

    return new Promise((resolve) => {
        qp.onDidChangeActive((actives) => {
            const a = actives && actives[0];
            if (a) {
                // Immediately stop current speech before speaking new history item
                resetTTSState();
                speakDebounced(
                    `${a.label}. ${a.description || ''}`,
                    `hist:active:${a.label}`
                );
            }
        });

        qp.onDidAccept(() => {
            const selected = qp.selectedItems[0];
            if (selected) {
                speakDebounced(`Opening set: ${selected.label}`, `hist:open:${selected.label}`);
                resetTTSState();
                resolve(selected.saved);
            } else {
                resetTTSState();
                resolve(null);
            }
            qp.dispose();
        });

        qp.onDidHide(() => {
            resetTTSState();
            resolve(null);
            qp.dispose();
        });

        qp.show();
    });
}

/**
 * Auto-cleanup old suggestions (older than 1 hour)
 */
export function cleanupOldSuggestions(): void {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    let cleanedCount = 0;
    
    for (const [id, suggestion] of savedSuggestions.entries()) {
        if (suggestion.timestamp < oneHourAgo) {
            savedSuggestions.delete(id);
            cleanedCount++;
            
            // Clear current if it was cleaned up
            if (currentSuggestionId === id) {
                currentSuggestionId = null;
            }
        }
    }
    
    if (cleanedCount > 0) {
        log(`[SuggestionStorage] Cleaned up ${cleanedCount} old suggestions`);
    }
}

// Auto-cleanup every 30 minutes
setInterval(cleanupOldSuggestions, 30 * 60 * 1000);

export function _debugResetSuggestionTTS() {
    resetTTSState();
}
