import * as vscode from 'vscode';
import { log, logError, logSuccess } from '../utils';
import { getConversationalProcessor } from '../conversational_asr';
import { ConversationalResponse } from '../conversational_asr';

/**
 * Natural Language Command Processor
 * Allows users to type natural language commands in Command Palette
 * and execute them using the same LLM processing as ASR
 */
export class NaturalLanguageCommandProcessor {
    private conversationalProcessor: any;

    constructor() {
        // Get the same conversational processor used by ASR
        this.conversationalProcessor = getConversationalProcessor();
    }

    /**
     * Process natural language text input and execute appropriate commands
     */
    async processNaturalLanguageCommand(inputText: string): Promise<ConversationalResponse> {
        try {
            log(`[NaturalLanguageCommand] Processing text input: "${inputText}"`);
            
            // Use the same conversational processor as ASR
            const response = await this.conversationalProcessor.processTranscription(inputText, { mode: 'command' });
            
            log(`[NaturalLanguageCommand] Response: ${response.response}`);
            return response;
            
        } catch (error) {
            logError(`[NaturalLanguageCommand] Error processing natural language command: ${error}`);
            return {
                response: `Error processing command: ${error}`,
                actions: [],
                shouldSpeak: false
            };
        }
    }

    /**
     * Show input dialog and process natural language command
     */
    async showNaturalLanguageCommandDialog(): Promise<void> {
        try {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter a natural language command (e.g., "open the file explorer", "save this file", "go to line 50")',
                placeHolder: 'Type your command in natural language...',
                title: 'LipCoder: Natural Language Command',
                ignoreFocusOut: true
            });

            if (!input || input.trim() === '') {
                return;
            }

            const trimmedInput = input.trim();
            log(`[NaturalLanguageCommand] User input: "${trimmedInput}"`);

            // Show processing status
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "LipCoder: Processing command...",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `"${trimmedInput}"` });
                
                try {
                    const response = await this.processNaturalLanguageCommand(trimmedInput);
                    
                    // Show result to user
                    if (response.response) {
                        if (response.response.includes('Error') || response.response.includes('error')) {
                            vscode.window.showErrorMessage(`LipCoder: ${response.response}`);
                        } else {
                            vscode.window.showInformationMessage(`LipCoder: ${response.response}`);
                        }
                    }
                    
                    logSuccess(`[NaturalLanguageCommand] Command executed successfully: "${response.response}"`);
                    
                } catch (error) {
                    logError(`[NaturalLanguageCommand] Error in command execution: ${error}`);
                    vscode.window.showErrorMessage(`LipCoder: Failed to execute command - ${error}`);
                }
            });

        } catch (error) {
            logError(`[NaturalLanguageCommand] Error showing dialog: ${error}`);
            vscode.window.showErrorMessage(`LipCoder: Error showing command dialog - ${error}`);
        }
    }
}

// Global instance
let naturalLanguageProcessor: NaturalLanguageCommandProcessor | null = null;

/**
 * Get or create the natural language command processor
 */
export function getNaturalLanguageProcessor(): NaturalLanguageCommandProcessor {
    if (!naturalLanguageProcessor) {
        naturalLanguageProcessor = new NaturalLanguageCommandProcessor();
    }
    return naturalLanguageProcessor;
}

/**
 * Register natural language command functionality
 */
export function registerNaturalLanguageCommand(context: vscode.ExtensionContext): void {
    log('[NaturalLanguageCommand] Registering natural language command functionality...');

    // Main natural language command
    const naturalLanguageCommandHandler = async () => {
        try {
            const processor = getNaturalLanguageProcessor();
            await processor.showNaturalLanguageCommandDialog();
        } catch (error) {
            logError(`[NaturalLanguageCommand] Error in command handler: ${error}`);
            vscode.window.showErrorMessage(`LipCoder: Error executing natural language command - ${error}`);
        }
    };

    const naturalLanguageDisposable = vscode.commands.registerCommand(
        'lipcoder.naturalLanguageCommand', 
        naturalLanguageCommandHandler
    );
    context.subscriptions.push(naturalLanguageDisposable);

    // Quick natural language command (with predefined examples)
    const quickCommandHandler = async () => {
        try {
            const quickCommands = [
                'Open file explorer',
                'Save current file', 
                'Format this document',
                'Go to terminal',
                'Show function list',
                'Copy current line',
                'Delete this line',
                'Close current tab',
                'Go to line number...',
                'Show problems panel',
                'Custom command...'
            ];

            const selected = await vscode.window.showQuickPick(quickCommands, {
                title: 'LipCoder: Quick Natural Language Commands',
                placeHolder: 'Select a common command or choose "Custom command..." to type your own'
            });

            if (!selected) {
                return;
            }

            let commandToExecute = selected;

            // Handle custom command
            if (selected === 'Custom command...') {
                const customInput = await vscode.window.showInputBox({
                    prompt: 'Enter your custom natural language command',
                    placeHolder: 'e.g., "find the main function", "run the build script"',
                    title: 'LipCoder: Custom Natural Language Command'
                });

                if (!customInput || customInput.trim() === '') {
                    return;
                }
                commandToExecute = customInput.trim();
            }

            // Handle "Go to line number..." specially
            if (selected === 'Go to line number...') {
                const lineInput = await vscode.window.showInputBox({
                    prompt: 'Enter line number to go to',
                    placeHolder: 'e.g., 42',
                    validateInput: (value) => {
                        const num = parseInt(value);
                        if (isNaN(num) || num < 1) {
                            return 'Please enter a valid line number (1 or greater)';
                        }
                        return null;
                    }
                });

                if (!lineInput) {
                    return;
                }
                commandToExecute = `go to line ${lineInput}`;
            }

            // Process the command
            const processor = getNaturalLanguageProcessor();
            
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "LipCoder: Processing command...",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `"${commandToExecute}"` });
                
                try {
                    const response = await processor.processNaturalLanguageCommand(commandToExecute);
                    
                    // Show result
                    if (response.response) {
                        if (response.response.includes('Error') || response.response.includes('error')) {
                            vscode.window.showErrorMessage(`LipCoder: ${response.response}`);
                        } else {
                            vscode.window.showInformationMessage(`LipCoder: ${response.response}`);
                        }
                    }
                    
                } catch (error) {
                    logError(`[NaturalLanguageCommand] Error in quick command: ${error}`);
                    vscode.window.showErrorMessage(`LipCoder: Failed to execute command - ${error}`);
                }
            });

        } catch (error) {
            logError(`[NaturalLanguageCommand] Error in quick command handler: ${error}`);
            vscode.window.showErrorMessage(`LipCoder: Error in quick command - ${error}`);
        }
    };

    const quickCommandDisposable = vscode.commands.registerCommand(
        'lipcoder.quickNaturalLanguageCommand', 
        quickCommandHandler
    );
    context.subscriptions.push(quickCommandDisposable);

    log('[NaturalLanguageCommand] Natural language command functionality registered successfully');
}

/**
 * Dispose natural language command resources
 */
export function disposeNaturalLanguageCommand(): void {
    if (naturalLanguageProcessor) {
        naturalLanguageProcessor = null;
        log('[NaturalLanguageCommand] Natural language command processor disposed');
    }
}
