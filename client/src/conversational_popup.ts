import * as vscode from 'vscode';
import { log, logError, logSuccess } from './utils';
import { ConversationalResponse, ConversationalAction } from './conversational_asr';
import { CommandRouter } from './command_router';
import { activateVibeCoding } from './features/vibe_coding';

/**
 * Conversational popup system that shows LLM responses with clickable action options
 * Provides a natural, non-blocking way for users to interact with the AI assistant
 */
export class ConversationalPopup {
    private currentQuickPick: vscode.QuickPick<ConversationalActionItem> | null = null;
    private statusBarItem: vscode.StatusBarItem | null = null;

    constructor() {
        // Create status bar item for showing conversation status
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        this.statusBarItem.text = '$(comment-discussion) LipCoder';
        this.statusBarItem.tooltip = 'Conversational AI Assistant';
        this.statusBarItem.show();
    }

    /**
     * Show conversational response with action options
     */
    async showConversationalResponse(response: ConversationalResponse): Promise<void> {
        try {
            log(`[ConversationalPopup] Showing response: "${response.response}"`);
            
            // Update status bar to show active conversation
            if (this.statusBarItem) {
                this.statusBarItem.text = '$(comment-discussion) Active';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            }

            // Close any existing popup
            this.closeCurrentPopup();

            // Create quick pick for actions
            this.currentQuickPick = vscode.window.createQuickPick<ConversationalActionItem>();
            
            // Set up the popup
            this.setupQuickPick(response);
            
            // Show the popup
            this.currentQuickPick.show();
            
            // Set up event handlers
            this.setupEventHandlers();

        } catch (error) {
            logError(`[ConversationalPopup] Error showing response: ${error}`);
        }
    }

    /**
     * Set up the quick pick with response and actions
     */
    private setupQuickPick(response: ConversationalResponse): void {
        if (!this.currentQuickPick) return;

        // Set the title to the AI response
        this.currentQuickPick.title = `🤖 ${response.response}`;
        
        // Set placeholder text
        this.currentQuickPick.placeholder = response.actions.length > 0 
            ? 'Choose an action or press Escape to continue...' 
            : 'Press Escape to continue...';

        // Convert actions to quick pick items
        const items: ConversationalActionItem[] = response.actions.map(action => ({
            label: `${action.icon || '$(arrow-right)'} ${action.label}`,
            description: action.description,
            detail: '', // We can add more details here if needed
            action: action
        }));

        // Add a "Continue" option at the end
        items.push({
            label: '$(arrow-right) Continue',
            description: 'Continue without taking any action',
            detail: '',
            action: {
                id: 'continue',
                label: 'Continue',
                description: 'Continue without action',
                command: 'continue'
            }
        });

        this.currentQuickPick.items = items;

        // Enable filtering but keep all items visible
        this.currentQuickPick.canSelectMany = false;
        this.currentQuickPick.matchOnDescription = true;
        this.currentQuickPick.matchOnDetail = true;

        // Auto-focus the first action if available
        if (items.length > 0) {
            this.currentQuickPick.activeItems = [items[0]];
        }
    }

    /**
     * Set up event handlers for the quick pick
     */
    private setupEventHandlers(): void {
        if (!this.currentQuickPick) return;

        // Handle selection
        this.currentQuickPick.onDidAccept(async () => {
            const selectedItem = this.currentQuickPick?.selectedItems[0];
            if (selectedItem) {
                await this.executeAction(selectedItem.action);
            }
            this.closeCurrentPopup();
        });

        // Handle dismissal
        this.currentQuickPick.onDidHide(() => {
            this.closeCurrentPopup();
        });

        // Handle item changes (for preview/hover effects)
        this.currentQuickPick.onDidChangeActive((items) => {
            if (items.length > 0) {
                const item = items[0];
                // Could add preview functionality here
                log(`[ConversationalPopup] Hovering over: ${item.action.label}`);
            }
        });
    }

    /**
     * Execute a dynamic suggestion based on its type and instruction
     */
    private async executeDynamicSuggestion(action: ConversationalAction): Promise<void> {
        try {
            const { type, instruction, originalRequest } = action.parameters || {};
            
            if (!type || !instruction) {
                vscode.window.showErrorMessage('Invalid suggestion parameters');
                return;
            }

            log(`[ConversationalPopup] Executing dynamic suggestion: ${type} - ${instruction}`);

            switch (type) {
                case 'explain':
                    // Show explanation in a new document or information message
                    await this.showExplanation(instruction, originalRequest);
                    break;

                case 'code':
                    // Generate new code using vibe coding
                    await activateVibeCoding(instruction);
                    break;

                case 'modify':
                    // Modify existing code using vibe coding
                    await activateVibeCoding(instruction);
                    break;

                case 'test':
                    // Create or run tests
                    await this.handleTestSuggestion(instruction);
                    break;

                case 'navigate':
                    // Navigate to different parts of code
                    await this.handleNavigationSuggestion(instruction);
                    break;

                case 'debug':
                    // Help with debugging
                    await this.handleDebugSuggestion(instruction);
                    break;

                case 'refactor':
                    // Refactor code
                    await activateVibeCoding(instruction);
                    break;

                case 'document':
                    // Add documentation
                    await activateVibeCoding(instruction);
                    break;

                default:
                    // Fallback to vibe coding for unknown types
                    await activateVibeCoding(instruction);
                    break;
            }

            vscode.window.showInformationMessage(`Executed: ${action.label}`);

            // Generate new suggestions for the next step
            await this.generateFollowUpSuggestions(action);

        } catch (error) {
            logError(`[ConversationalPopup] Error executing dynamic suggestion: ${error}`);
            vscode.window.showErrorMessage(`Failed to execute suggestion: ${error}`);
        }
    }

    /**
     * Show explanation in a dedicated output channel or document
     */
    private async showExplanation(instruction: string, originalRequest?: string): Promise<void> {
        try {
            // Create a new untitled document to show the explanation
            const doc = await vscode.workspace.openTextDocument({
                content: `# Code Explanation\n\n**Original Request:** ${originalRequest || 'N/A'}\n\n**Explanation:**\n${instruction}\n\n---\n*Generated by LipCoder AI Assistant*`,
                language: 'markdown'
            });
            
            await vscode.window.showTextDocument(doc);
            
            // Also speak the explanation using TTS
            await this.speakExplanation(instruction);
        } catch (error) {
            // Fallback to information message and speech
            vscode.window.showInformationMessage(instruction);
            await this.speakExplanation(instruction);
        }
    }

    /**
     * Speak explanation using TTS
     */
    private async speakExplanation(explanation: string): Promise<void> {
        try {
            const { speakTokenList } = await import('./audio.js');
            
            // Speak as simple plain text without code reading tokens
            const chunks = [{
                tokens: [explanation],
                category: undefined  // No category = plain text TTS
            }];
            
            await speakTokenList(chunks);
            log(`[ConversationalPopup] Spoke explanation: "${explanation.substring(0, 50)}..."`);
        } catch (error) {
            logError(`[ConversationalPopup] Error speaking explanation: ${error}`);
        }
    }

    /**
     * Handle test-related suggestions
     */
    private async handleTestSuggestion(instruction: string): Promise<void> {
        // For now, use vibe coding to generate tests
        // In the future, this could integrate with specific testing frameworks
        await activateVibeCoding(`Create tests: ${instruction}`);
    }

    /**
     * Handle navigation suggestions
     */
    private async handleNavigationSuggestion(instruction: string): Promise<void> {
        // Parse common navigation patterns
        const lowerInstruction = instruction.toLowerCase();
        
        if (lowerInstruction.includes('function') || lowerInstruction.includes('method')) {
            // Navigate to function
            await vscode.commands.executeCommand('workbench.action.quickOpen', '@');
        } else if (lowerInstruction.includes('line')) {
            // Go to line
            await vscode.commands.executeCommand('workbench.action.gotoLine');
        } else if (lowerInstruction.includes('symbol')) {
            // Go to symbol
            await vscode.commands.executeCommand('workbench.action.quickOpen', '#');
        } else if (lowerInstruction.includes('file')) {
            // Open file
            await vscode.commands.executeCommand('workbench.action.quickOpen');
        } else {
            // Fallback: show instruction as information
            vscode.window.showInformationMessage(`Navigation: ${instruction}`);
        }
    }

    /**
     * Handle debug-related suggestions
     */
    private async handleDebugSuggestion(instruction: string): Promise<void> {
        const lowerInstruction = instruction.toLowerCase();
        
        if (lowerInstruction.includes('breakpoint')) {
            // Toggle breakpoint
            await vscode.commands.executeCommand('editor.debug.action.toggleBreakpoint');
        } else if (lowerInstruction.includes('start debug') || lowerInstruction.includes('run debug')) {
            // Start debugging
            await vscode.commands.executeCommand('workbench.action.debug.start');
        } else if (lowerInstruction.includes('console')) {
            // Open debug console
            await vscode.commands.executeCommand('workbench.debug.action.toggleRepl');
        } else {
            // Fallback: show instruction and suggest using vibe coding for debug code
            vscode.window.showInformationMessage(`Debug suggestion: ${instruction}`);
            await activateVibeCoding(`Add debugging code: ${instruction}`);
        }
    }

    /**
     * Generate follow-up suggestions after completing an action
     */
    private async generateFollowUpSuggestions(completedAction: ConversationalAction): Promise<void> {
        try {
            log(`[ConversationalPopup] Generating follow-up suggestions after: ${completedAction.label}`);

            // Wait a moment for the action to complete
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Import the conversational ASR processor
            const { getConversationalProcessor } = await import('./conversational_asr.js');
            const processor = getConversationalProcessor();

            // Create a follow-up intent based on the completed action
            const followUpText = this.createFollowUpText(completedAction);
            
            // Generate new suggestions using the conversational processor
            const followUpIntent = {
                type: 'vibe_coding' as const,
                confidence: 0.9,
                originalText: followUpText,
                intent: `Follow up after: ${completedAction.label}`,
                parameters: {
                    previousAction: completedAction.label,
                    actionType: completedAction.parameters?.type
                }
            };

            // Generate dynamic suggestions for the follow-up
            const suggestions = await (processor as any).generateDynamicSuggestions(followUpIntent);

            if (suggestions && suggestions.length > 0) {
                // Create a new conversational response with follow-up suggestions
                const followUpResponse = {
                    response: `Great! What would you like to do next?`,
                    actions: suggestions,
                    shouldSpeak: false // Don't speak automatically for follow-ups
                };

                // Show the new suggestions
                await this.showConversationalResponse(followUpResponse);
                log(`[ConversationalPopup] Showed ${suggestions.length} follow-up suggestions`);
            } else {
                log(`[ConversationalPopup] No follow-up suggestions generated`);
            }

        } catch (error) {
            logError(`[ConversationalPopup] Error generating follow-up suggestions: ${error}`);
            // Don't show error to user for follow-up suggestions, just log it
        }
    }

    /**
     * Create appropriate follow-up text based on the completed action
     */
    private createFollowUpText(completedAction: ConversationalAction): string {
        const actionType = completedAction.parameters?.type;
        const originalRequest = completedAction.parameters?.originalRequest;

        switch (actionType) {
            case 'explain':
                return `I just explained the code. Now help me improve or modify it further.`;
            case 'code':
                return `I just generated new code. What should we do next with this implementation?`;
            case 'modify':
                return `I just modified the code. What other improvements can we make?`;
            case 'test':
                return `I just created tests. What else should we test or improve?`;
            case 'navigate':
                return `I just navigated to the code. Now let's work on improving it.`;
            case 'debug':
                return `I just added debugging features. What other debugging improvements do we need?`;
            case 'refactor':
                return `I just refactored the code. What other improvements should we make?`;
            case 'document':
                return `I just added documentation. What other code improvements are needed?`;
            default:
                return `I completed "${completedAction.label}". What should we work on next?`;
        }
    }

    /**
     * Execute the selected action
     */
    private async executeAction(action: ConversationalAction): Promise<void> {
        try {
            log(`[ConversationalPopup] Executing action: ${action.command}`);

            switch (action.command) {
                case 'continue':
                    // Just close the popup, no action needed
                    break;

                case 'vibeCoding':
                    await activateVibeCoding();
                    break;

                case 'analyzeCode':
                    await vscode.commands.executeCommand('lipcoder.analyzeCode');
                    break;

                case 'findFunction':
                    await vscode.commands.executeCommand('workbench.action.quickOpen', '@');
                    break;

                case 'askQuestion':
                    await vscode.commands.executeCommand('lipcoder.askLLMQuestion');
                    break;

                case 'giveCommand':
                    // Show a hint about available commands
                    vscode.window.showInformationMessage(
                        'Try commands like: "go to line 50", "find function getName", "open terminal", "go to explorer"'
                    );
                    break;

                case 'showCommands':
                    await vscode.commands.executeCommand('workbench.action.showCommands');
                    break;

                case 'showHelp':
                    await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'lipcoder.help');
                    break;

                case 'retryCommand':
                    if (action.parameters?.originalText) {
                        try {
                            log(`[ConversationalPopup] Creating CommandRouter for retry...`);
                            const commandRouter = new CommandRouter({ 
                                enableLogging: true,
                                showNotifications: true 
                            });
                            
                            // Set editor context for proper command execution
                            const editor = vscode.window.activeTextEditor;
                            if (editor) {
                                const context = {
                                    editor: editor,
                                    position: editor.selection.active,
                                    selection: editor.selection,
                                    documentUri: editor.document.uri
                                };
                                commandRouter.setEditorContext(context);
                                log(`[ConversationalPopup] Editor context set for retry CommandRouter`);
                            }
                            
                            log(`[ConversationalPopup] Processing retry command...`);
                            await commandRouter.processTranscription(action.parameters.originalText);
                        } catch (routerError) {
                            logError(`[ConversationalPopup] CommandRouter failed for retry: ${routerError}`);
                            if (routerError instanceof Error) {
                                logError(`[ConversationalPopup] Retry error stack: ${routerError.stack}`);
                            }
                            vscode.window.showErrorMessage(`Failed to retry command: ${routerError}`);
                        }
                    }
                    break;

                case 'applyVibeChanges':
                    // This would integrate with vibe coding's accept functionality
                    try {
                        await vscode.commands.executeCommand('lipcoder.acceptVibeChanges');
                    } catch (error) {
                        // Fallback: try to execute vibe coding voice commands
                        const { handleVibeCodingVoiceCommand } = await import('./features/vibe_coding.js');
                        await handleVibeCodingVoiceCommand('accept');
                    }
                    
                    // Generate follow-up suggestions after applying changes
                    await this.generateFollowUpSuggestions({
                        ...action,
                        parameters: { type: 'modify', originalRequest: 'Applied code changes' }
                    });
                    break;

                case 'rejectVibeChanges':
                    try {
                        await vscode.commands.executeCommand('lipcoder.rejectVibeChanges');
                    } catch (error) {
                        // Fallback: try to execute vibe coding voice commands
                        const { handleVibeCodingVoiceCommand } = await import('./features/vibe_coding.js');
                        await handleVibeCodingVoiceCommand('reject');
                    }
                    break;

                case 'modifyVibeRequest':
                    await activateVibeCoding();
                    
                    // Generate follow-up suggestions after modifying request
                    await this.generateFollowUpSuggestions({
                        ...action,
                        parameters: { type: 'modify', originalRequest: 'Modified vibe coding request' }
                    });
                    break;

                case 'insertText':
                    // Insert the text directly into the active editor
                    if (action.parameters?.text) {
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            const textToInsert = action.parameters.text;
                            await editor.edit(editBuilder => {
                                editBuilder.insert(editor.selection.active, textToInsert + ' ');
                            });
                            vscode.window.showInformationMessage(`Text inserted: ${textToInsert}`);
                        } else {
                            vscode.window.showWarningMessage('No active editor to insert text');
                        }
                    }
                    break;

                case 'executeDynamicSuggestion':
                    await this.executeDynamicSuggestion(action);
                    break;

                case 'continueEditing':
                    // Focus back on the editor
                    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                    break;

                case 'newRequest':
                    // Clear conversation history and show input
                    vscode.window.showInputBox({
                        prompt: 'What would you like me to help you with?',
                        placeHolder: 'Ask a question, give a command, or describe code changes...'
                    }).then(async input => {
                        if (input) {
                            // Process the new request through conversational flow
                            const { processConversationalASR } = await import('./conversational_asr.js');
                            const { showConversationalResponse } = await import('./conversational_popup.js');
                            
                            const conversationalResponse = await processConversationalASR(input);
                            await showConversationalResponse(conversationalResponse);
                        }
                    });
                    break;

                default:
                    // Try to route through the command router
                    try {
                        log(`[ConversationalPopup] Creating CommandRouter for default action...`);
                        const commandRouter = new CommandRouter();
                        
                        // Set editor context for proper command execution
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            const context = {
                                editor: editor,
                                position: editor.selection.active,
                                selection: editor.selection,
                                documentUri: editor.document.uri
                            };
                            commandRouter.setEditorContext(context);
                            log(`[ConversationalPopup] Editor context set for default CommandRouter`);
                        }
                        
                        const commandText = action.parameters ? 
                            `${action.command} ${JSON.stringify(action.parameters)}` : 
                            action.command;
                        log(`[ConversationalPopup] Processing default action: ${commandText}`);
                        await commandRouter.processTranscription(commandText);
                    } catch (routerError) {
                        logError(`[ConversationalPopup] CommandRouter failed for default action: ${routerError}`);
                        if (routerError instanceof Error) {
                            logError(`[ConversationalPopup] Default action error stack: ${routerError.stack}`);
                        }
                        vscode.window.showErrorMessage(`Failed to execute action: ${routerError}`);
                    }
                    break;
            }

            logSuccess(`[ConversationalPopup] Action executed: ${action.command}`);

        } catch (error) {
            logError(`[ConversationalPopup] Error executing action: ${error}`);
            vscode.window.showErrorMessage(`Failed to execute action: ${error}`);
        }
    }

    /**
     * Close the current popup
     */
    private closeCurrentPopup(): void {
        if (this.currentQuickPick) {
            this.currentQuickPick.dispose();
            this.currentQuickPick = null;
        }

        // Reset status bar
        if (this.statusBarItem) {
            this.statusBarItem.text = '$(comment-discussion) LipCoder';
            this.statusBarItem.backgroundColor = undefined;
        }

        log('[ConversationalPopup] Popup closed');
    }

    /**
     * Show a simple notification popup (non-blocking)
     */
    async showNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
        switch (type) {
            case 'info':
                vscode.window.showInformationMessage(message);
                break;
            case 'warning':
                vscode.window.showWarningMessage(message);
                break;
            case 'error':
                vscode.window.showErrorMessage(message);
                break;
        }
    }

    /**
     * Show a quick status update in the status bar
     */
    showStatusUpdate(message: string, duration: number = 3000): void {
        if (!this.statusBarItem) return;

        const originalText = this.statusBarItem.text;
        this.statusBarItem.text = `$(info) ${message}`;
        
        setTimeout(() => {
            if (this.statusBarItem) {
                this.statusBarItem.text = originalText;
            }
        }, duration);
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.closeCurrentPopup();
        
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
            this.statusBarItem = null;
        }
    }
}

/**
 * Interface for quick pick items that contain conversational actions
 */
interface ConversationalActionItem extends vscode.QuickPickItem {
    action: ConversationalAction;
}

// Global instance
let globalConversationalPopup: ConversationalPopup | null = null;

/**
 * Get or create the global conversational popup
 */
export function getConversationalPopup(): ConversationalPopup {
    if (!globalConversationalPopup) {
        globalConversationalPopup = new ConversationalPopup();
    }
    return globalConversationalPopup;
}

/**
 * Show a conversational response with actions
 */
export async function showConversationalResponse(response: ConversationalResponse): Promise<void> {
    const popup = getConversationalPopup();
    await popup.showConversationalResponse(response);
}

/**
 * Show a simple notification
 */
export async function showConversationalNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
    const popup = getConversationalPopup();
    await popup.showNotification(message, type);
}

/**
 * Show a status update
 */
export function showConversationalStatus(message: string, duration?: number): void {
    const popup = getConversationalPopup();
    popup.showStatusUpdate(message, duration);
}

/**
 * Clean up conversational popup resources
 */
export function disposeConversationalPopup(): void {
    if (globalConversationalPopup) {
        globalConversationalPopup.dispose();
        globalConversationalPopup = null;
    }
}
