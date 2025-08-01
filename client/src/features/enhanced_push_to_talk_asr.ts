import * as vscode from 'vscode';
import * as path from 'path';
import { ASRClient, ASRChunk } from '../asr';
import { GPT4oASRClient, GPT4oASRChunk } from '../gpt4o_asr';
import { ASRPopup } from '../asr_popup';
import { currentASRBackend, ASRBackend, loadConfigFromSettings } from '../config';
import { CommandRouter, findFunctionWithLLM, executePackageJsonScript, type RouterEditorContext } from '../command_router';
import { log, logError, logWarning, logSuccess } from '../utils';
import { stopAllAudio } from './stop_reading';

let asrClient: ASRClient | null = null;
let gpt4oAsrClient: GPT4oASRClient | null = null;
let asrPopup: ASRPopup | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let commandRouter: CommandRouter | null = null;
let isRecording = false;
let context: vscode.ExtensionContext | null = null;

// Track editor context when recording starts
interface EditorContext {
    editor: vscode.TextEditor;
    position: vscode.Position;
    selection: vscode.Selection;
    documentUri: vscode.Uri;
}

let recordingContext: EditorContext | null = null;
let autoStopTimer: NodeJS.Timeout | null = null;
const MAX_RECORDING_DURATION = 30000; // 30 seconds max

// ASR Mode Configuration
enum ASRMode {
    Command = 'command',
    Write = 'write'
}

let currentASRMode: ASRMode = ASRMode.Command;

/**
 * Get the appropriate ASR client based on current backend
 */
function getCurrentASRClient(): ASRClient | GPT4oASRClient | null {
    return currentASRBackend === ASRBackend.GPT4o ? gpt4oAsrClient : asrClient;
}

/**
 * Clean up all ASR resources
 */
function cleanupASRResources(): void {
    logWarning('[Enhanced-ASR] Cleaning up ASR resources...');
    
    // Stop any ongoing recording
    if (isRecording) {
        stopRecording();
    }
    
    // Dispose clients
    if (asrClient) {
        asrClient.dispose();
        asrClient = null;
    }
    
    if (gpt4oAsrClient) {
        gpt4oAsrClient.dispose();
        gpt4oAsrClient = null;
    }
    
    // Hide popup
    if (asrPopup) {
        asrPopup.dispose();
        asrPopup = null;
    }
    
    // Reset command router
    commandRouter = null;
    
    // Clear recording context
    recordingContext = null;
    
    // Clear auto-stop timer
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    
    // Reset context key
    setRecordingContextKey(false);
    
    logSuccess('[Enhanced-ASR] ASR resources cleaned up');
}

/**
 * Update status bar item
 */
function updateStatusBar(recording: boolean): void {
    if (!statusBarItem) return;
    
    if (recording) {
        const modeText = currentASRMode === ASRMode.Command ? 'Command' : 'Write';
        const stopKey = currentASRMode === ASRMode.Command ? 'Ctrl+Shift+A' : 'Ctrl+Shift+W';
        statusBarItem.text = `$(record) Recording ${modeText} Mode... Press ${stopKey} to stop (${currentASRBackend})`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.tooltip = `Recording in ${modeText} mode. Press ${stopKey} again to stop and process speech.`;
    } else {
        statusBarItem.text = `$(mic) ASR Ready - Ctrl+Shift+A (Commands) / Ctrl+Shift+W (Write) (${currentASRBackend})`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'Press Ctrl+Shift+A for command mode or Ctrl+Shift+W for write mode. Commands execute in current editor context.';
    }
}

/**
 * Initialize ASR clients based on current backend
 */
function initializeASRClients(): void {
    try {
        // Load configuration from VS Code settings
        loadConfigFromSettings();
        
        log(`[Enhanced-ASR] Initializing ASR clients for backend: ${currentASRBackend}`);
        
        // Always initialize both clients, but only use the selected one
        if (!asrClient) {
            try {
                asrClient = new ASRClient({
                    onTranscription: async (chunk: ASRChunk) => {
                        if (chunk && chunk.text) {
                            await handleTranscription(chunk.text);
                        }
                    },
                    onError: (error: Error) => {
                        if (error) {
                            handleError(error);
                        }
                    }
                });
                
                // Verify the client was created properly
                if (!asrClient || typeof asrClient !== 'object') {
                    throw new Error('ASRClient constructor returned invalid object');
                }
                
                log('[Enhanced-ASR] ASRClient initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize ASRClient: ${error}`);
                asrClient = null; // Ensure it's explicitly null on failure
            }
        }
        
        if (!gpt4oAsrClient) {
            try {
                gpt4oAsrClient = new GPT4oASRClient({
                    onTranscription: async (chunk: GPT4oASRChunk) => {
                        if (chunk && chunk.text) {
                            await handleTranscription(chunk.text);
                        }
                    },
                    onError: (error: Error) => {
                        if (error) {
                            handleError(error);
                        }
                    },
                    onRecordingStart: () => {
                        handleRecordingStart();
                    },
                    onRecordingStop: () => {
                        handleRecordingStop();
                    }
                });
                
                // Verify the client was created properly
                if (!gpt4oAsrClient || typeof gpt4oAsrClient !== 'object') {
                    throw new Error('GPT4oASRClient constructor returned invalid object');
                }
                
                log('[Enhanced-ASR] GPT4oASRClient initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize GPT4oASRClient: ${error}`);
                gpt4oAsrClient = null; // Ensure it's explicitly null on failure
            }
        }
        
        // Initialize popup
        if (!asrPopup) {
            try {
                asrPopup = new ASRPopup({
                    title: `LipCoder ASR (${currentASRBackend})`,
                    showWaveform: true,
                    showTranscription: true
                });
                
                // Verify the popup was created properly
                if (!asrPopup || typeof asrPopup !== 'object') {
                    throw new Error('ASRPopup constructor returned invalid object');
                }
                
                log('[Enhanced-ASR] ASRPopup initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize ASRPopup: ${error}`);
                asrPopup = null; // Ensure it's explicitly null on failure
            }
        }
        
        // Initialize command router
        if (!commandRouter) {
            try {
                commandRouter = new CommandRouter({
                    showNotifications: true,
                    enableLogging: true,
                    fallbackToTextInsertion: true,
                    useLLMMatching: true
                });
                
                // Verify the command router was created properly
                if (!commandRouter || typeof commandRouter !== 'object') {
                    throw new Error('CommandRouter constructor returned invalid object');
                }
                
                log('[Enhanced-ASR] CommandRouter initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize CommandRouter: ${error}`);
                commandRouter = null; // Ensure it's explicitly null on failure
            }
        }
        
        // Final verification
        const initialized = {
            asrClient: !!asrClient,
            gpt4oAsrClient: !!gpt4oAsrClient,
            asrPopup: !!asrPopup,
            commandRouter: !!commandRouter
        };
        
        log(`[Enhanced-ASR] Initialization status: ${JSON.stringify(initialized)}`);
        
        if (!asrClient && !gpt4oAsrClient) {
            logError('[Enhanced-ASR] Critical: No ASR clients successfully initialized!');
        }
        
        if (!commandRouter) {
            logError('[Enhanced-ASR] Critical: Command router failed to initialize!');
        }
        
        logSuccess('[Enhanced-ASR] ASR client initialization completed');
    } catch (error) {
        logError(`[Enhanced-ASR] Critical failure during ASR client initialization: ${error}`);
        // Don't throw the error, just log it to prevent extension activation failure
    }
}

/**
 * Handle transcription result
 */
async function handleTranscription(text: string): Promise<void> {
    log(`[Enhanced-ASR] ================================================`);
    log(`[Enhanced-ASR] Transcription received: "${text}" (Mode: ${currentASRMode})`);
    log(`[Enhanced-ASR] Text length: ${text.length}`);
    log(`[Enhanced-ASR] Text bytes: ${JSON.stringify([...text].map(c => c.charCodeAt(0)))}`);
    log(`[Enhanced-ASR] Current mode: ${currentASRMode}`);
    log(`[Enhanced-ASR] Command router available: ${!!commandRouter}`);
    
    // Update popup
    if (asrPopup) {
        asrPopup.updateTranscription(text);
    }
    
    // Output to channel
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${text} (${currentASRMode} mode)`);
        outputChannel.show(true);
    }
    
    // Try to process as command first (only in command mode)
    let commandExecuted = false;
    if (currentASRMode === ASRMode.Command && commandRouter) {
        try {
            log(`[Enhanced-ASR] 🚀 Calling command router with: "${text}"`);
            commandExecuted = await commandRouter.processTranscription(text);
            log(`[Enhanced-ASR] Command router result: ${commandExecuted}`);
        } catch (error) {
            logError(`[Enhanced-ASR] Command router processing failed: ${error}`);
        }
    } else {
        log(`[Enhanced-ASR] ⚪ Not calling command router - Mode: ${currentASRMode}, Router: ${!!commandRouter}`);
    }
    
    // If no command was executed (or in write mode), fall back to text insertion
    if (!commandExecuted) {
        // Try to use captured editor context first, then fall back to active editor
        let targetEditor = recordingContext?.editor;
        
        // Validate captured editor
        if (targetEditor) {
            try {
                if (!targetEditor.document || targetEditor.document.isClosed) {
                    log('[Enhanced-ASR] Captured editor context is no longer valid for text insertion, falling back to active editor');
                    targetEditor = undefined;
                }
            } catch (error) {
                logError(`[Enhanced-ASR] Error accessing captured editor for text insertion: ${error}`);
                targetEditor = undefined;
            }
        }
        
        // Fallback to current active editor
        if (!targetEditor) {
            targetEditor = vscode.window.activeTextEditor;
        }
        
        if (targetEditor) {
            try {
                // Make sure the target editor is active
                await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                
                // Use original cursor position if available, otherwise current position
                const insertPosition = recordingContext?.position || targetEditor.selection.active;
                
                await targetEditor.edit(editBuilder => {
                    editBuilder.insert(insertPosition, text + ' ');
                });
                
                const fileName = path.basename(targetEditor.document.fileName);
                log(`[Enhanced-ASR] Text inserted in ${fileName} at line ${insertPosition.line + 1}`);
            } catch (error) {
                logError(`[Enhanced-ASR] Error inserting text: ${error}`);
                vscode.window.showErrorMessage(`Failed to insert text: ${error}`);
            }
        } else {
            logWarning('[Enhanced-ASR] No editor available for text insertion');
            vscode.window.showWarningMessage('No editor available to insert transcribed text');
        }
        
        // Show notification for text insertion
        vscode.window.showInformationMessage(`ASR: ${text}`);
    }
}

/**
 * Set VS Code context key for recording state
 */
function setRecordingContextKey(recording: boolean): void {
    log(`[Enhanced-ASR] Setting context key 'lipcoder.isRecording' to: ${recording}`);
    vscode.commands.executeCommand('setContext', 'lipcoder.isRecording', recording);
}

/**
 * Handle recording start
 */
function handleRecordingStart(): void {
    log('[Enhanced-ASR] Recording started');
    isRecording = true;
    setRecordingContextKey(true);
    updateStatusBar(true);
    
    // Set up auto-stop timer
    autoStopTimer = setTimeout(() => {
        if (isRecording) {
            log('[Enhanced-ASR] Auto-stopping recording after maximum duration');
            stopRecording();
            vscode.window.showInformationMessage('Recording stopped automatically after 30 seconds');
        }
    }, MAX_RECORDING_DURATION);
    
    if (asrPopup) {
        asrPopup.setRecordingStatus(true);
    }
}

/**
 * Handle recording stop
 */
function handleRecordingStop(): void {
    log('[Enhanced-ASR] Recording stopped');
    isRecording = false;
    setRecordingContextKey(false);
    updateStatusBar(false);
    
    // Clear auto-stop timer
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    
    if (asrPopup) {
        asrPopup.setRecordingStatus(false);
    }
}

/**
 * Handle errors
 */
function handleError(error: Error): void {
    logError(`[Enhanced-ASR] Error: ${error.message}`);
    
    if (asrPopup) {
        asrPopup.showError(error.message);
    }
    
    vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
    
    // Stop recording on error
    if (isRecording) {
        stopRecording();
    }
}

/**
 * Capture current editor context for command execution
 */
function captureEditorContext(): EditorContext | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }
    
    return {
        editor: editor,
        position: editor.selection.active,
        selection: editor.selection,
        documentUri: editor.document.uri
    };
}

/**
 * Start recording in command mode
 */
async function startASRCommandMode(): Promise<void> {
    // Stop any ongoing audio/token reading immediately
    stopAllAudio();
    log(`[Enhanced-ASR] Stopped all audio for command mode recording`);
    
    currentASRMode = ASRMode.Command;
    log(`[Enhanced-ASR] Starting ASR in COMMAND mode`);
    await startRecording();
}

/**
 * Stop recording in command mode  
 */
async function stopASRCommandMode(): Promise<void> {
    if (currentASRMode === ASRMode.Command) {
        log(`[Enhanced-ASR] Stopping ASR command mode`);
        await stopRecording();
    } else {
        logWarning(`[Enhanced-ASR] Cannot stop command mode - current mode is ${currentASRMode}`);
    }
}

/**
 * Start recording in write mode
 */
async function startASRWriteMode(): Promise<void> {
    // Stop any ongoing audio/token reading immediately
    stopAllAudio();
    log(`[Enhanced-ASR] Stopped all audio for write mode recording`);
    
    currentASRMode = ASRMode.Write;
    log(`[Enhanced-ASR] Starting ASR in WRITE mode`);
    await startRecording();
}

/**
 * Stop recording in write mode
 */
async function stopASRWriteMode(): Promise<void> {
    if (currentASRMode === ASRMode.Write) {
        log(`[Enhanced-ASR] Stopping ASR write mode`);
        await stopRecording();  
    } else {
        logWarning(`[Enhanced-ASR] Cannot stop write mode - current mode is ${currentASRMode}`);
    }
}

/**
 * Start recording
 */
async function startRecording(): Promise<void> {
    if (isRecording) {
        logWarning('[Enhanced-ASR] Already recording');
        return;
    }
    
    try {
        log('[Enhanced-ASR] Starting ASR recording...');
        
        // Stop all ongoing audio/token reading before starting recording
        stopAllAudio();
        log('[Enhanced-ASR] Stopped all ongoing audio before recording');
        
        // Capture editor context at the start of recording
        recordingContext = captureEditorContext();
        if (recordingContext) {
            log(`[Enhanced-ASR] Captured context: ${recordingContext.documentUri.fsPath} at line ${recordingContext.position.line + 1}`);
        } else {
            logWarning('[Enhanced-ASR] No active editor - commands may not work properly');
        }
        
        // Initialize clients if needed
        initializeASRClients();
        
        // Set editor context on command router
        if (commandRouter && recordingContext) {
            const routerContext: RouterEditorContext = {
                editor: recordingContext.editor,
                position: recordingContext.position,
                selection: recordingContext.selection,
                documentUri: recordingContext.documentUri
            };
            commandRouter.setEditorContext(routerContext);
        }
        
        // Show popup
        if (asrPopup && context) {
            asrPopup.show(context);
        }
        
        // Start recording based on backend
        if (currentASRBackend === ASRBackend.GPT4o && gpt4oAsrClient && typeof gpt4oAsrClient === 'object') {
            try {
                if (typeof gpt4oAsrClient.startRecording === 'function') {
                    await gpt4oAsrClient.startRecording();
                } else {
                    throw new Error('GPT4o ASR client startRecording method not available');
                }
            } catch (error) {
                throw new Error(`Failed to start GPT4o ASR recording: ${error}`);
            }
        } else if (currentASRBackend === ASRBackend.Silero && asrClient && typeof asrClient === 'object') {
            try {
                if (typeof asrClient.startStreaming === 'function') {
                    await asrClient.startStreaming();
                    handleRecordingStart(); // Manual call for Silero
                } else {
                    throw new Error('Silero ASR client startStreaming method not available');
                }
            } catch (error) {
                throw new Error(`Failed to start Silero ASR recording: ${error}`);
            }
        } else {
            const availableClients = {
                gpt4o: !!gpt4oAsrClient,
                silero: !!asrClient,
                currentBackend: currentASRBackend
            };
            throw new Error(`ASR backend ${currentASRBackend} not available or not initialized. Status: ${JSON.stringify(availableClients)}`);
        }
        
        logSuccess('[Enhanced-ASR] Recording started successfully');
        
    } catch (error) {
        handleError(error as Error);
    }
}

/**
 * Stop recording
 */
async function stopRecording(): Promise<void> {
    if (!isRecording) {
        logWarning('[Enhanced-ASR] Not currently recording');
        return;
    }
    
    try {
        log('[Enhanced-ASR] Stopping ASR recording...');
        
        // Stop recording based on backend  
        if (currentASRBackend === ASRBackend.GPT4o && gpt4oAsrClient && typeof gpt4oAsrClient === 'object') {
            try {
                if (typeof gpt4oAsrClient.stopRecording === 'function') {
                    await gpt4oAsrClient.stopRecording();
                } else {
                    logError('[Enhanced-ASR] GPT4o ASR client stopRecording method not available');
                }
            } catch (error) {
                logError(`[Enhanced-ASR] Error stopping GPT4o recording: ${error}`);
            }
        } else if (currentASRBackend === ASRBackend.Silero && asrClient && typeof asrClient === 'object') {
            try {
                if (typeof asrClient.stopStreaming === 'function') {
                    asrClient.stopStreaming();
                    handleRecordingStop(); // Manual call for Silero
                } else {
                    logError('[Enhanced-ASR] Silero ASR client stopStreaming method not available');
                }
            } catch (error) {
                logError(`[Enhanced-ASR] Error stopping Silero recording: ${error}`);
            }
        } else {
            logWarning(`[Enhanced-ASR] No valid ASR client available to stop for backend: ${currentASRBackend}`);
        }
        
        logSuccess('[Enhanced-ASR] Recording stopped successfully');
        
    } catch (error) {
        handleError(error as Error);
    }
}

/**
 * Toggle recording
 */
async function toggleRecording(): Promise<void> {
    if (isRecording) {
        await stopRecording();
    } else {
        await startRecording();
    }
}

/**
 * Switch ASR backend
 */
async function switchASRBackend(): Promise<void> {
    const backends = [
        { label: 'GPT-4o Transcribe (Recommended)', value: ASRBackend.GPT4o, description: 'High accuracy, requires OpenAI API key' },
        { label: 'Silero (Local)', value: ASRBackend.Silero, description: 'Local processing, no API key required' }
    ];
    
    const selected = await vscode.window.showQuickPick(backends, {
        placeHolder: 'Select ASR backend',
        ignoreFocusOut: true
    });
    
    if (selected) {
        // Stop current recording if active
        if (isRecording) {
            await stopRecording();
        }
        
        // Clean up current clients
        cleanupASRResources();
        
        // Update configuration
        const config = vscode.workspace.getConfiguration('lipcoder');
        await config.update('asrBackend', selected.value, vscode.ConfigurationTarget.Global);
        
        // Reload configuration
        loadConfigFromSettings();
        
        // Update status bar
        updateStatusBar(false);
        
        vscode.window.showInformationMessage(`Switched to ${selected.label} ASR backend`);
        
        log(`[Enhanced-ASR] Switched to ${selected.value} backend`);
    }
}

/**
 * Register enhanced push-to-talk ASR commands
 */
export function registerEnhancedPushToTalkASR(extensionContext: vscode.ExtensionContext) {
    try {
        // Validate input parameters
        if (!extensionContext) {
            throw new Error('Extension context is required but was not provided');
        }
        
        if (!extensionContext.subscriptions) {
            throw new Error('Extension context subscriptions array is not available');
        }
        
        context = extensionContext;
        log('[Enhanced-ASR] Registering enhanced push-to-talk ASR commands');
        log(`[Enhanced-ASR] Extension context validated, subscriptions count: ${extensionContext.subscriptions.length}`);
        
        // Load configuration
        try {
            if (typeof loadConfigFromSettings !== 'function') {
                throw new Error('loadConfigFromSettings is not a function');
            }
            loadConfigFromSettings();
            log('[Enhanced-ASR] Configuration loaded successfully');
        } catch (configError) {
            logWarning(`[Enhanced-ASR] Config loading failed, using defaults: ${configError}`);
        }
        
        // Create output channel
        outputChannel = vscode.window.createOutputChannel('LipCoder Enhanced ASR');
        log('[Enhanced-ASR] Created output channel');
        
        // Create status bar item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusBarItem.command = 'lipcoder.toggleASRRecording';
        statusBarItem.tooltip = 'Click to toggle ASR recording (Ctrl+Shift+A)';
        updateStatusBar(false);
        statusBarItem.show();
        log('[Enhanced-ASR] Created status bar item');
        
        // Initialize context key
        setRecordingContextKey(false);
        log('[Enhanced-ASR] Initialized recording context key');
    
    // Validate command functions exist
    const commandFunctions = [
        { name: 'startRecording', func: startRecording },
        { name: 'stopRecording', func: stopRecording },
        { name: 'toggleRecording', func: toggleRecording },
        { name: 'switchASRBackend', func: switchASRBackend }
    ];
    
    for (const { name, func } of commandFunctions) {
        if (typeof func !== 'function') {
            throw new Error(`Command function ${name} is not defined or not a function`);
        }
    }
    log('[Enhanced-ASR] All command functions validated');
    
    // Register commands
    log('[Enhanced-ASR] Starting command registration...');
    context.subscriptions.push(
        // Main ASR recording commands
        vscode.commands.registerCommand('lipcoder.startASRRecording', startRecording),
        vscode.commands.registerCommand('lipcoder.stopASRRecording', stopRecording),
        vscode.commands.registerCommand('lipcoder.toggleASRRecording', toggleRecording),
        
        // New mode-specific ASR commands
        vscode.commands.registerCommand('lipcoder.startASRCommandMode', startASRCommandMode),
        vscode.commands.registerCommand('lipcoder.stopASRCommandMode', stopASRCommandMode),
        vscode.commands.registerCommand('lipcoder.startASRWriteMode', startASRWriteMode),
        vscode.commands.registerCommand('lipcoder.stopASRWriteMode', stopASRWriteMode),
        
        // Backend management
        vscode.commands.registerCommand('lipcoder.switchASRBackend', switchASRBackend),
        
        // Show Enhanced ASR output
        vscode.commands.registerCommand('lipcoder.showEnhancedASROutput', () => {
            if (outputChannel) {
                outputChannel.show();
            }
        }),
        
        // Clear Enhanced ASR output
        vscode.commands.registerCommand('lipcoder.clearEnhancedASROutput', () => {
            if (outputChannel) {
                outputChannel.clear();
            }
        }),
        
        // Show ASR popup manually
        vscode.commands.registerCommand('lipcoder.showASRPopup', () => {
            if (!context) {
                vscode.window.showErrorMessage('ASR: Extension context not available');
                return;
            }
            if (!asrPopup) {
                try {
                    asrPopup = new ASRPopup();
                } catch (error) {
                    logError(`[Enhanced-ASR] Failed to create ASR popup: ${error}`);
                    vscode.window.showErrorMessage(`Failed to create ASR popup: ${error}`);
                    return;
                }
            }
            try {
                asrPopup.show(context);
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to show ASR popup: ${error}`);
                vscode.window.showErrorMessage(`Failed to show ASR popup: ${error}`);
            }
        }),
        
        // Command Router management
        vscode.commands.registerCommand('lipcoder.showCommandPatterns', () => {
            if (!commandRouter) {
                vscode.window.showWarningMessage('Command router not initialized');
                return;
            }
            
            const patterns = commandRouter.getPatterns();
            const patternList = patterns.map(p => 
                `• ${p.description || p.command}: "${p.pattern}"`
            ).join('\n');
            
            vscode.window.showInformationMessage(
                `Available Command Patterns (${patterns.length}):\n\n${patternList}`,
                { modal: true }
            );
        }),
        
        vscode.commands.registerCommand('lipcoder.toggleCommandRouter', () => {
            if (!commandRouter) {
                vscode.window.showWarningMessage('Command router not initialized');
                return;
            }
            
            // Toggle between enabling and disabling notifications as a proxy for router activity
            const currentOptions = commandRouter.getPatterns().length > 0;
            if (currentOptions) {
                commandRouter.clearPatterns();
                vscode.window.showInformationMessage('Command router disabled - will only insert text');
            } else {
                commandRouter.resetToDefaults();
                vscode.window.showInformationMessage('Command router enabled with default patterns');
            }
        }),
        
        vscode.commands.registerCommand('lipcoder.toggleLLMMatching', () => {
            if (!commandRouter) {
                vscode.window.showWarningMessage('Command router not initialized');
                return;
            }
            
            // Toggle LLM matching
            const currentOptions = commandRouter.getPatterns().length > 0;
            if (currentOptions) {
                commandRouter.updateOptions({ useLLMMatching: false });
                vscode.window.showInformationMessage('LLM matching disabled - using exact pattern matching only');
            } else {
                commandRouter.updateOptions({ useLLMMatching: true });
                vscode.window.showInformationMessage('LLM matching enabled - using intelligent command interpretation');
            }
        }),
        
        vscode.commands.registerCommand('lipcoder.addCustomCommandPattern', async () => {
            if (!commandRouter) {
                vscode.window.showWarningMessage('Command router not initialized');
                return;
            }
            
            const pattern = await vscode.window.showInputBox({
                prompt: 'Enter speech pattern to match (e.g., "close file")',
                placeHolder: 'Speech pattern...'
            });
            
            if (!pattern) return;
            
            const command = await vscode.window.showInputBox({
                prompt: 'Enter VS Code command to execute',
                placeHolder: 'workbench.action.closeActiveEditor'
            });
            
            if (!command) return;
            
            const description = await vscode.window.showInputBox({
                prompt: 'Enter description (optional)',
                placeHolder: 'Close active file'
            });
            
            try {
                commandRouter.addPattern({
                    pattern: pattern,
                    command: command,
                    description: description || command,
                    preventDefault: true
                });
                
                                 vscode.window.showInformationMessage(`Added custom command pattern: "${pattern}" → ${command}`);
             } catch (error) {
                 vscode.window.showErrorMessage(`Failed to add pattern: ${error}`);
             }
         }),
         
         // Manual function navigation
         vscode.commands.registerCommand('lipcoder.goToFunction', async () => {
             const functionName = await vscode.window.showInputBox({
                 prompt: 'Enter function name to navigate to',
                 placeHolder: 'handleClick'
             });
             
             if (!functionName) return;
             
             if (!commandRouter) {
                 vscode.window.showWarningMessage('Command router not initialized');
                 return;
             }
             
             // Use the same LLM function search
             try {
                 const position = await findFunctionWithLLM(functionName);
                 if (position) {
                     const editor = vscode.window.activeTextEditor;
                     if (editor) {
                         const newPosition = new vscode.Position(position.line, position.character);
                         editor.selection = new vscode.Selection(newPosition, newPosition);
                         editor.revealRange(new vscode.Range(newPosition, newPosition));
                         vscode.window.showInformationMessage(`Found function: ${functionName} at line ${position.line + 1}`);
                     }
                 } else {
                     vscode.window.showWarningMessage(`Function "${functionName}" not found`);
                 }
             } catch (error) {
                 vscode.window.showErrorMessage(`Failed to find function: ${error}`);
             }
         }),
         
         // Manual script execution
         vscode.commands.registerCommand('lipcoder.runPackageScript', async () => {
             const scriptName = await vscode.window.showInputBox({
                 prompt: 'Enter npm script name to run',
                 placeHolder: 'build'
             });
             
             if (!scriptName) return;
             
             try {
                 await executePackageJsonScript(scriptName);
             } catch (error) {
                 vscode.window.showErrorMessage(`Failed to run script: ${error}`);
             }
         }),
         
         // Debug command to check recording state
         vscode.commands.registerCommand('lipcoder.debugASRState', () => {
             const state = {
                 isRecording: isRecording,
                 hasRecordingContext: !!recordingContext,
                 contextEditor: recordingContext?.editor?.document.fileName || 'none',
                 contextPosition: recordingContext?.position ? `${recordingContext.position.line}:${recordingContext.position.character}` : 'none',
                 currentBackend: currentASRBackend,
                 hasAsrClient: !!asrClient,
                 hasGpt4oClient: !!gpt4oAsrClient,
                 hasCommandRouter: !!commandRouter,
                 activeEditor: vscode.window.activeTextEditor?.document.fileName || 'none'
             };
             
             vscode.window.showInformationMessage(
                 `ASR Debug State:\n${JSON.stringify(state, null, 2)}`,
                 { modal: true }
             );
             
             log(`[Enhanced-ASR] Debug state: ${JSON.stringify(state, null, 2)}`);
         })
    );
    
    // Register cleanup
    context.subscriptions.push({
        dispose: cleanupASRResources
    });
    
        // Initialize clients
        log('[Enhanced-ASR] About to initialize ASR clients...');
        try {
            if (typeof initializeASRClients !== 'function') {
                throw new Error('initializeASRClients is not a function');
            }
            initializeASRClients();
            log('[Enhanced-ASR] ASR clients initialized successfully');
        } catch (clientError) {
            logError(`[Enhanced-ASR] Failed to initialize ASR clients: ${clientError}`);
            logError(`[Enhanced-ASR] Client error type: ${typeof clientError}`);
            if (clientError instanceof Error) {
                logError(`[Enhanced-ASR] Client error stack: ${clientError.stack}`);
            }
            throw clientError; // Re-throw to be caught by outer try-catch
        }
        
        logSuccess('[Enhanced-ASR] Enhanced push-to-talk ASR registered successfully');
    } catch (error) {
        logError(`[Enhanced-ASR] Failed to register enhanced push-to-talk ASR: ${error}`);
        logError(`[Enhanced-ASR] Error type: ${typeof error}`);
        logError(`[Enhanced-ASR] Error constructor: ${error?.constructor?.name}`);
        if (error instanceof Error) {
            logError(`[Enhanced-ASR] Error message: ${error.message}`);
            logError(`[Enhanced-ASR] Error stack: ${error.stack}`);
        }
        
        // Show error to user with more detail
        vscode.window.showErrorMessage(`Failed to activate Enhanced ASR: ${error}. Check output panel for details.`);
        
        // Don't throw the error to prevent extension activation failure
    }
} 