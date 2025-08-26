import * as vscode from 'vscode';
import { log } from '../utils';
import { ConversationalAction } from '../conversational_asr';

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
 * Show the current suggestions in a quick pick menu
 */
export async function showCurrentSuggestions(): Promise<ConversationalAction | null> {
    const current = getCurrentSuggestions();
    if (!current) {
        vscode.window.showInformationMessage('No saved suggestions available. Use ASR commands to generate suggestions first.');
        return null;
    }
    
    log(`[SuggestionStorage] Showing ${current.suggestions.length} suggestions for: "${current.originalCommand}"`);
    
    // Create quick pick items
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `Continue with Suggestions (${current.originalCommand})`;
    quickPick.placeholder = 'Select a suggestion to execute...';
    
    interface SuggestionQuickPickItem extends vscode.QuickPickItem {
        suggestion: ConversationalAction;
        index: number;
    }
    
    const items: SuggestionQuickPickItem[] = current.suggestions.map((suggestion, index) => ({
        label: `$(lightbulb) ${suggestion.label}`,
        description: suggestion.description || '',
        detail: suggestion.type ? `Type: ${suggestion.type}` : undefined,
        suggestion: suggestion,
        index: index
    }));
    
    quickPick.items = items;
    
    return new Promise((resolve) => {
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
            resolve(null);
            quickPick.dispose();
        });
        
        quickPick.show();
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
