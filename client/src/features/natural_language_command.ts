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
     * This should EXACTLY mimic ASR behavior
     */
    async processNaturalLanguageCommand(inputText: string): Promise<ConversationalResponse> {
        try {
            log(`[NaturalLanguageCommand] Processing text input: "${inputText}"`);
            
            // First, try exact commands (same as ASR)
            const { tryExactCommand } = await import('./exact_commands.js');
            const exactResult = await tryExactCommand(inputText);
            if (exactResult) {
                log(`[NaturalLanguageCommand] Exact command executed: "${inputText}"`);
                return exactResult;
            }
            
            // Then, try direct vibe coding detection (bypass conversational ASR complexity)
            if (this.isVibeCodingIntent(inputText)) {
                log(`[NaturalLanguageCommand] Direct vibe coding detected: "${inputText}"`);
                return await this.handleDirectVibeCoding(inputText);
            }
            
            // For everything else, use the conversational processor (same as ASR)
            const response = await this.conversationalProcessor.processTranscription(inputText);
            
            log(`[NaturalLanguageCommand] Response: ${response.response}, shouldSpeak: ${response.shouldSpeak}`);
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
     * Detect if this is a vibe coding intent using simple keyword detection
     * This mimics what ASR does but more directly
     */
    private isVibeCodingIntent(text: string): boolean {
        const lowerText = text.toLowerCase();
        
        // Vibe coding keywords (same logic as conversational ASR but more direct)
        const vibeCodingKeywords = [
            'implement', 'create', 'add', 'modify', 'complete', 'generate', 'write',
            'refactor', 'update', 'change', 'fix', 'improve', 'optimize',
            '구현', '만들어', '추가', '수정', '완성', '생성', '작성',
            '리팩토링', '업데이트', '변경', '고치', '개선', '최적화'
        ];
        
        const hasVibeCodingKeyword = vibeCodingKeywords.some(keyword => lowerText.includes(keyword));
        
        // Code-related context
        const codeKeywords = [
            'function', 'class', 'method', 'variable', 'code', 'script',
            'algorithm', 'logic', 'feature', 'component',
            '함수', '클래스', '메서드', '변수', '코드', '스크립트',
            '알고리즘', '로직', '기능', '컴포넌트'
        ];
        
        const hasCodeContext = codeKeywords.some(keyword => lowerText.includes(keyword));
        
        // If it has vibe coding keywords OR (code context and action words)
        return hasVibeCodingKeyword || (hasCodeContext && (
            lowerText.includes('해줘') || lowerText.includes('please') || 
            lowerText.includes('can you') || lowerText.includes('could you')
        ));
    }

    /**
     * Handle vibe coding directly - exactly like ASR does
     */
    private async handleDirectVibeCoding(inputText: string): Promise<ConversationalResponse> {
        try {
            log(`[NaturalLanguageCommand] Executing direct vibe coding for: "${inputText}"`);
            
            // Import and call activateVibeCoding directly (same as ASR)
            const { activateVibeCoding } = await import('./vibe_coding.js');
            await activateVibeCoding(inputText, { suppressConversationalASR: true });
            
            return {
                response: "Executing your code request...",
                actions: [],
                shouldSpeak: false // Let vibe coding handle its own audio feedback
            };
        } catch (error) {
            logError(`[NaturalLanguageCommand] Error in direct vibe coding: ${error}`);
            return {
                response: `Error executing vibe coding: ${error}`,
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
                prompt: 'Enter any command that you can speak to LipCoder (navigation, execution, file operations, etc.)',
                placeHolder: 'e.g., "go to explorer", "run code", "fix errors", "open README", "go to line 50"...',
                title: 'LipCoder: Natural Language Command (All ASR Features Available)',
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
                    
                    // Show result to user - be smarter about success/error detection
                    if (response.response) {
                        const isError = response.response.includes('Error') || 
                                      response.response.includes('error') ||
                                      response.response.includes('Failed') ||
                                      response.response.includes('failed') ||
                                      response.response.includes('Could not') ||
                                      response.response.includes('Unable to');
                        
                        if (isError) {
                            vscode.window.showErrorMessage(`LipCoder: ${response.response}`, { modal: false });
                        } else {
                            // For successful commands, show a more subtle notification
                            vscode.window.showInformationMessage(`LipCoder: ${response.response}`, { modal: false });
                        }
                    }
                    
                    // Execute any additional actions if present
                    if (response.actions && response.actions.length > 0) {
                        log(`[NaturalLanguageCommand] Executing ${response.actions.length} additional actions`);
                        for (const action of response.actions) {
                            try {
                                if (action.command) {
                                    const params = action.parameters ? Object.values(action.parameters) : [];
                                    await vscode.commands.executeCommand(action.command, ...params);
                                }
                            } catch (actionError) {
                                logError(`[NaturalLanguageCommand] Failed to execute action: ${actionError}`);
                            }
                        }
                    }
                    
                    logSuccess(`[NaturalLanguageCommand] Command executed successfully: "${response.response}"`);
                    
                } catch (error) {
                    logError(`[NaturalLanguageCommand] Error in command execution: ${error}`);
                    vscode.window.showErrorMessage(`LipCoder: Failed to execute command - ${error}`, { modal: false });
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
