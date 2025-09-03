import * as vscode from 'vscode';
import { log } from '../utils';
import { config } from '../config';
import { speakTokenList } from '../audio';

let findWidgetActive = false;
let findWidgetTimeout: NodeJS.Timeout | null = null;

/**
 * Check if find widget is currently active
 */
export function isFindWidgetActive(): boolean {
    return findWidgetActive;
}

/**
 * Set find widget active state with auto-timeout
 */
function setFindWidgetActive(active: boolean): void {
    findWidgetActive = active;
    log(`[FindDialogSimple] Find widget active: ${active}`);

    if (active) {
        // Auto-deactivate after 30 seconds to prevent stuck state
        if (findWidgetTimeout) {
            clearTimeout(findWidgetTimeout);
        }
        findWidgetTimeout = setTimeout(() => {
            findWidgetActive = false;
            log('[FindDialogSimple] Find widget auto-deactivated after timeout');
        }, 30000);
    } else {
        if (findWidgetTimeout) {
            clearTimeout(findWidgetTimeout);
            findWidgetTimeout = null;
        }
    }
}

/**
 * Handle typing sound for find dialog
 */
async function playFindTypingSound(char: string): Promise<void> {
    if (!config.typingSpeechEnabled || !findWidgetActive) {
        return;
    }

    try {
        await speakTokenList([{
            tokens: [char],
            category: 'variable'
        }]);
        log(`[FindDialogSimple] Played typing sound for: "${char}"`);
    } catch (error) {
        log(`[FindDialogSimple] Error playing typing sound: ${error}`);
    }
}

/**
 * Setup automatic typing detection for find widget
 */
function setupAutomaticTypingDetection(context: vscode.ExtensionContext): void {
    let typingDebounceTimer: NodeJS.Timeout | null = null;
    
    // Store original executeCommand function
    const originalExecuteCommand = vscode.commands.executeCommand;
    
    // Create wrapper to intercept typing commands
    const executeCommandWrapper = async function(command: string, ...args: any[]) {
        // Intercept the 'type' command which is triggered for all typing in VSCode
        if (command === 'type' && findWidgetActive) {
            const typeArgs = args[0] as { text?: string };
            if (typeArgs && typeArgs.text) {
                const typedText = typeArgs.text;
                log(`[FindDialogSimple] Auto-detected typing in find widget: "${typedText}"`);
                
                // Clear existing debounce timer
                if (typingDebounceTimer) {
                    clearTimeout(typingDebounceTimer);
                }
                
                // Debounce typing to avoid too frequent audio
                typingDebounceTimer = setTimeout(async () => {
                    await playFindTypingSound(typedText);
                }, 50); // 50ms debounce for responsive typing
            }
        }
        
        // Execute the original command with cancellation-safe handling
        try {
            return await originalExecuteCommand.call(vscode.commands, command, ...args);
        } catch (err: any) {
            const isCanceled = err && (err.name === 'Canceled' || String(err).includes('Canceled'));
            if (isCanceled) {
                // Swallow benign cancellation errors to avoid unhandled rejections
                log('[FindDialogSimple] Ignored cancellation from executeCommand');
                return undefined as any;
            }
            throw err;
        }
    };

    // Replace the executeCommand function
    (vscode.commands as any).executeCommand = executeCommandWrapper;

    // Additional approach: Monitor document changes while find widget is active
    // This can catch some typing that might not be caught by the type command
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            // Only process if find widget is active and this might be related to find
            if (!findWidgetActive) {
                return;
            }

            // Check if this is a very small change that might be from find widget typing
            const changes = event.contentChanges;
            if (changes.length === 1) {
                const change = changes[0];
                const text = change.text;
                
                // If it's a single character change and very recent after find widget activation
                if (text.length === 1 && /[a-zA-Z0-9\s]/.test(text)) {
                    const timeSinceActivation = Date.now() - (findWidgetTimeout ? 0 : Date.now());
                    log(`[FindDialogSimple] Potential find widget typing detected: "${text}"`);
                    
                    // Clear existing debounce timer
                    if (typingDebounceTimer) {
                        clearTimeout(typingDebounceTimer);
                    }
                    
                    // Play typing sound with debounce
                    typingDebounceTimer = setTimeout(async () => {
                        await playFindTypingSound(text);
                    }, 100);
                }
            }
        })
    );

    // Monitor selection changes to detect find results (secondary detection)
    let lastSelectionText = '';
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (!findWidgetActive) {
                return;
            }

            const selection = event.selections[0];
            if (selection && !selection.isEmpty) {
                const selectedText = event.textEditor.document.getText(selection);
                
                // If this is a new selection and find widget is active, it indicates search activity
                if (selectedText !== lastSelectionText && selectedText.length > 0 && selectedText.length < 100) {
                    lastSelectionText = selectedText;
                    log(`[FindDialogSimple] Find result detected: "${selectedText}"`);
                }
            }
        })
    );

    // Clean up on disposal
    context.subscriptions.push({
        dispose: () => {
            if (typingDebounceTimer) {
                clearTimeout(typingDebounceTimer);
                typingDebounceTimer = null;
            }
            // Restore original executeCommand
            (vscode.commands as any).executeCommand = originalExecuteCommand;
            log('[FindDialogSimple] Automatic typing detection cleaned up');
        }
    });
}

/**
 * Register simple find dialog typing support
 */
export function registerFindDialogSimple(context: vscode.ExtensionContext): void {
    // Setup automatic typing detection
    setupAutomaticTypingDetection(context);
    // Command to open find widget with audio feedback
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openFindWidget', async () => {
            log('[FindDialogSimple] Opening find widget via Ctrl+F');
            
            // Activate find widget state
            setFindWidgetActive(true);
            
            // Execute the actual find command
            await vscode.commands.executeCommand('actions.find');
            
            // Announce find dialog opening
            if (config.typingSpeechEnabled) {
                try {
                    await speakTokenList([{
                        tokens: ['찾기'],
                        category: 'comment_text'
                    }]);
                } catch (error) {
                    log(`[FindDialogSimple] Error announcing find dialog: ${error}`);
                }
            }
        })
    );

    // Command to manually trigger typing sound (can be bound to keys)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.findTypingSound', async (args?: { char?: string }) => {
            const char = args?.char || 'a'; // Default character
            await playFindTypingSound(char);
        })
    );

    // Commands for individual characters (a-z, 0-9)
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (const char of chars) {
        const commandId = `lipcoder.findType_${char}`;
        context.subscriptions.push(
            vscode.commands.registerCommand(commandId, async () => {
                if (findWidgetActive) {
                    await playFindTypingSound(char);
                }
            })
        );
    }

    // Command for space
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.findType_space', async () => {
            if (findWidgetActive) {
                await playFindTypingSound(' ');
            }
        })
    );

    // Command for backspace
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.findType_backspace', async () => {
            if (findWidgetActive) {
                await playFindTypingSound('backspace');
            }
        })
    );

    // Command to close find widget
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.closeFindWidget', async () => {
            log('[FindDialogSimple] Closing find widget');
            setFindWidgetActive(false);
            
            // Execute the actual close command
            await vscode.commands.executeCommand('closeFindWidget');
        })
    );

    // Command to toggle find widget state manually (for testing)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.toggleFindWidgetState', () => {
            setFindWidgetActive(!findWidgetActive);
            const status = findWidgetActive ? 'active' : 'inactive';
            vscode.window.showInformationMessage(`Find widget is now ${status}`);
        })
    );

    // Monitor editor focus changes to detect find widget activity
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor && findWidgetActive) {
                log('[FindDialogSimple] Editor lost focus - find widget likely receiving input');
            } else if (editor && findWidgetActive) {
                // Don't auto-deactivate immediately, user might be switching between find and editor
                log('[FindDialogSimple] Editor focus changed, find widget still active');
            }
        })
    );

    // Additional method: Monitor window state changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (findWidgetActive && state.focused) {
                log('[FindDialogSimple] Window focused while find widget active');
            }
        })
    );

    // Clean up on disposal
    context.subscriptions.push({
        dispose: () => {
            if (findWidgetTimeout) {
                clearTimeout(findWidgetTimeout);
                findWidgetTimeout = null;
            }
            findWidgetActive = false;
            log('[FindDialogSimple] Cleaned up find dialog resources');
        }
    });

    log('[FindDialogSimple] Simple find dialog typing support registered');
}

/**
 * Clean up find dialog resources
 */
export function cleanupFindDialogSimple(): void {
    if (findWidgetTimeout) {
        clearTimeout(findWidgetTimeout);
        findWidgetTimeout = null;
    }
    findWidgetActive = false;
    log('[FindDialogSimple] Find dialog resources cleaned up');
}
