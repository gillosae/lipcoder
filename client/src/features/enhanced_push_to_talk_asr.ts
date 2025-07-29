import * as vscode from 'vscode';
import { ASRClient, ASRChunk } from '../asr';
import { GPT4oASRClient, GPT4oASRChunk } from '../gpt4o_asr';
import { ASRPopup } from '../asr_popup';
import { currentASRBackend, ASRBackend, loadConfigFromSettings } from '../config';
import { log, logError, logWarning, logSuccess } from '../utils';

let asrClient: ASRClient | null = null;
let gpt4oAsrClient: GPT4oASRClient | null = null;
let asrPopup: ASRPopup | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let isRecording = false;
let context: vscode.ExtensionContext | null = null;

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
    
    logSuccess('[Enhanced-ASR] ASR resources cleaned up');
}

/**
 * Update status bar item
 */
function updateStatusBar(recording: boolean): void {
    if (!statusBarItem) return;
    
    if (recording) {
        statusBarItem.text = `$(record) Recording (${currentASRBackend})`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = `$(mic) ASR (${currentASRBackend})`;
        statusBarItem.backgroundColor = undefined;
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
                    onTranscription: (chunk: ASRChunk) => {
                        handleTranscription(chunk.text);
                    },
                    onError: (error: Error) => {
                        handleError(error);
                    }
                });
                log('[Enhanced-ASR] ASRClient initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize ASRClient: ${error}`);
            }
        }
        
        if (!gpt4oAsrClient) {
            try {
                gpt4oAsrClient = new GPT4oASRClient({
                    onTranscription: (chunk: GPT4oASRChunk) => {
                        handleTranscription(chunk.text);
                    },
                    onError: (error: Error) => {
                        handleError(error);
                    },
                    onRecordingStart: () => {
                        handleRecordingStart();
                    },
                    onRecordingStop: () => {
                        handleRecordingStop();
                    }
                });
                log('[Enhanced-ASR] GPT4oASRClient initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize GPT4oASRClient: ${error}`);
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
                log('[Enhanced-ASR] ASRPopup initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize ASRPopup: ${error}`);
            }
        }
        
        logSuccess('[Enhanced-ASR] ASR clients initialized successfully');
    } catch (error) {
        logError(`[Enhanced-ASR] Failed to initialize ASR clients: ${error}`);
        // Don't throw the error, just log it
    }
}

/**
 * Handle transcription result
 */
function handleTranscription(text: string): void {
    log(`[Enhanced-ASR] Transcription received: "${text}"`);
    
    // Update popup
    if (asrPopup) {
        asrPopup.updateTranscription(text);
    }
    
    // Output to channel
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${text}`);
        outputChannel.show(true);
    }
    
    // Insert at cursor if editor is active
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const position = editor.selection.active;
        editor.edit(editBuilder => {
            editBuilder.insert(position, text + ' ');
        });
    }
    
    // Show notification
    vscode.window.showInformationMessage(`ASR: ${text}`);
}

/**
 * Handle recording start
 */
function handleRecordingStart(): void {
    log('[Enhanced-ASR] Recording started');
    isRecording = true;
    updateStatusBar(true);
    
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
    updateStatusBar(false);
    
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
 * Start recording
 */
async function startRecording(): Promise<void> {
    if (isRecording) {
        logWarning('[Enhanced-ASR] Already recording');
        return;
    }
    
    try {
        log('[Enhanced-ASR] Starting ASR recording...');
        
        // Initialize clients if needed
        initializeASRClients();
        
        // Show popup
        if (asrPopup && context) {
            asrPopup.show(context);
        }
        
        // Start recording based on backend
        if (currentASRBackend === ASRBackend.GPT4o && gpt4oAsrClient) {
            try {
                await gpt4oAsrClient.startRecording();
            } catch (error) {
                throw new Error(`Failed to start GPT4o ASR recording: ${error}`);
            }
        } else if (currentASRBackend === ASRBackend.Silero && asrClient) {
            try {
                await asrClient.startStreaming();
                handleRecordingStart(); // Manual call for Silero
            } catch (error) {
                throw new Error(`Failed to start Silero ASR recording: ${error}`);
            }
        } else {
            throw new Error(`ASR backend ${currentASRBackend} not available or not initialized`);
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
        if (currentASRBackend === ASRBackend.GPT4o && gpt4oAsrClient) {
            try {
                await gpt4oAsrClient.stopRecording();
            } catch (error) {
                logError(`[Enhanced-ASR] Error stopping GPT4o recording: ${error}`);
            }
        } else if (currentASRBackend === ASRBackend.Silero && asrClient) {
            try {
                asrClient.stopStreaming();
                handleRecordingStop(); // Manual call for Silero
            } catch (error) {
                logError(`[Enhanced-ASR] Error stopping Silero recording: ${error}`);
            }
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
        context = extensionContext;
        log('[Enhanced-ASR] Registering enhanced push-to-talk ASR commands');
        
        // Load configuration
        try {
            loadConfigFromSettings();
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
    
    // Register commands
    context.subscriptions.push(
        // Main ASR recording commands
        vscode.commands.registerCommand('lipcoder.startASRRecording', startRecording),
        vscode.commands.registerCommand('lipcoder.stopASRRecording', stopRecording),
        vscode.commands.registerCommand('lipcoder.toggleASRRecording', toggleRecording),
        
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
        })
    );
    
    // Register cleanup
    context.subscriptions.push({
        dispose: cleanupASRResources
    });
    
        // Initialize clients
        initializeASRClients();
        
        logSuccess('[Enhanced-ASR] Enhanced push-to-talk ASR registered successfully');
    } catch (error) {
        logError(`[Enhanced-ASR] Failed to register enhanced push-to-talk ASR: ${error}`);
        // Don't throw the error to prevent extension activation failure
    }
} 