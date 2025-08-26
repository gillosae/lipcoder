import * as vscode from 'vscode';
import { log } from '../utils';
import { saveSuggestions, getCurrentSuggestions, showCurrentSuggestions, hasCurrentSuggestions, clearCurrentSuggestions } from './suggestion_storage';
import { ConversationalAction } from '../conversational_asr';

/**
 * Test the suggestion storage system
 */
export async function testSuggestionStorage(): Promise<void> {
    log('[TestSuggestionStorage] Starting suggestion storage test...');
    
    try {
        // Clear any existing suggestions
        clearCurrentSuggestions();
        
        // Test 1: Check that no suggestions exist initially
        if (hasCurrentSuggestions()) {
            throw new Error('Expected no suggestions initially');
        }
        log('[TestSuggestionStorage] ✅ Initial state check passed');
        
        // Test 2: Save some test suggestions
        const testSuggestions: ConversationalAction[] = [
            {
                id: 'test_1',
                label: 'Create a test function',
                description: 'Generate a simple test function',
                command: 'vibe_coding',
                parameters: { instruction: 'create a test function' },
                type: 'code'
            },
            {
                id: 'test_2',
                label: 'Add error handling',
                description: 'Add try-catch blocks',
                command: 'vibe_coding',
                parameters: { instruction: 'add error handling' },
                type: 'modify'
            },
            {
                id: 'test_3',
                label: 'Write documentation',
                description: 'Add JSDoc comments',
                command: 'vibe_coding',
                parameters: { instruction: 'write documentation' },
                type: 'document'
            }
        ];
        
        const suggestionId = saveSuggestions('create a function with error handling', testSuggestions);
        log(`[TestSuggestionStorage] ✅ Saved suggestions with ID: ${suggestionId}`);
        
        // Test 3: Check that suggestions exist
        if (!hasCurrentSuggestions()) {
            throw new Error('Expected suggestions to exist after saving');
        }
        log('[TestSuggestionStorage] ✅ Suggestions existence check passed');
        
        // Test 4: Retrieve saved suggestions
        const retrieved = getCurrentSuggestions();
        if (!retrieved) {
            throw new Error('Expected to retrieve saved suggestions');
        }
        
        if (retrieved.suggestions.length !== 3) {
            throw new Error(`Expected 3 suggestions, got ${retrieved.suggestions.length}`);
        }
        
        if (retrieved.originalCommand !== 'create a function with error handling') {
            throw new Error(`Expected original command to match, got: ${retrieved.originalCommand}`);
        }
        
        log('[TestSuggestionStorage] ✅ Suggestion retrieval test passed');
        
        // Test 5: Show suggestions UI (this will open the quick pick)
        vscode.window.showInformationMessage('Test: Opening suggestion picker in 2 seconds...');
        setTimeout(async () => {
            try {
                const selectedAction = await showCurrentSuggestions();
                if (selectedAction) {
                    log(`[TestSuggestionStorage] ✅ User selected: ${selectedAction.label}`);
                    vscode.window.showInformationMessage(`Selected: ${selectedAction.label}`);
                } else {
                    log('[TestSuggestionStorage] ℹ️ User cancelled selection');
                    vscode.window.showInformationMessage('Selection cancelled');
                }
            } catch (error) {
                log(`[TestSuggestionStorage] ❌ UI test error: ${error}`);
                vscode.window.showErrorMessage(`UI test error: ${error}`);
            }
        }, 2000);
        
        log('[TestSuggestionStorage] ✅ All tests passed! Check the UI test in 2 seconds.');
        vscode.window.showInformationMessage('Suggestion storage test completed! Check console for details.');
        
    } catch (error) {
        log(`[TestSuggestionStorage] ❌ Test failed: ${error}`);
        vscode.window.showErrorMessage(`Suggestion storage test failed: ${error}`);
        throw error;
    }
}

/**
 * Register the test command
 */
export function registerTestSuggestionStorage(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand('lipcoder.testSuggestionStorage', testSuggestionStorage);
    context.subscriptions.push(command);
    log('[TestSuggestionStorage] Test command registered');
}
