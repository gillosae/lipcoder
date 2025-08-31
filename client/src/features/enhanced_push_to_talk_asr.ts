import * as vscode from 'vscode';
import * as path from 'path';
import { ASRClient, ASRChunk } from '../asr';
import { GPT4oASRClient, GPT4oASRChunk } from '../gpt4o_asr';
import { HuggingFaceWhisperClient, HuggingFaceWhisperChunk } from '../huggingface_whisper_asr';
import { ASRPopup } from '../asr_popup';
import { currentASRBackend, ASRBackend, loadConfigFromSettings } from '../config';
import { CommandRouter, findFunctionWithLLM, executePackageJsonScript, type RouterEditorContext } from '../command_router';
import { log, logError, logWarning, logSuccess } from '../utils';
import { stopAllAudio, setASRRecordingActive } from './stop_reading';
import { speakTokenList, TokenChunk } from '../audio';
import { playEarcon } from '../earcon';
import { handleASRError } from '../asr_error_handler';
import { getLastActiveEditor, isEditorActive } from '../ide/active';
import { goToLastDetectedError } from './terminal';

let asrClient: ASRClient | null = null;
let gpt4oAsrClient: GPT4oASRClient | null = null;
let huggingFaceWhisperClient: HuggingFaceWhisperClient | null = null;
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
let lastKnownEditorContext: EditorContext | null = null; // Remember last valid editor
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
 * Speak an error message using the TTS system
 */
async function speakErrorMessage(message: string): Promise<void> {
    try {
        log(`[Enhanced-ASR] Speaking error message: "${message}"`);
        
        // Use pure TTS without any special token processing
        const chunks: TokenChunk[] = [{
            tokens: [message],
            category: undefined  // No category = pure TTS without earcons
        }];
        
        // Stop any ongoing audio first
        stopAllAudio();
        
        // Speak the error message
        await speakTokenList(chunks);
        
        log(`[Enhanced-ASR] Successfully spoke error message`);
    } catch (error) {
        logError(`[Enhanced-ASR] Failed to speak error message: ${error}`);
    }
}

/**
 * Clean up all ASR resources
 */
export function cleanupASRResources(): void {
    logWarning('[Enhanced-ASR] Cleaning up ASR resources...');
    
    // Stop any ongoing recording
    if (isRecording) {
        stopRecording();
    }
    
    // Clear ASR recording flag to allow token reading again
    setASRRecordingActive(false);
    log('[Enhanced-ASR] Cleared ASR recording flag during cleanup');
    
    // Dispose clients
    if (asrClient) {
        asrClient.dispose();
        asrClient = null;
    }
    
    if (gpt4oAsrClient) {
        gpt4oAsrClient.dispose();
        gpt4oAsrClient = null;
    }
    
    if (huggingFaceWhisperClient) {
        huggingFaceWhisperClient.dispose();
        huggingFaceWhisperClient = null;
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
 * Initialize ASR clients based on current backend
 */
function initializeASRClients(): void {
    try {
        // Load configuration from VS Code settings
        loadConfigFromSettings();
        
        log(`[Enhanced-ASR] 🔍 Initializing ASR clients for backend: ${currentASRBackend}`);
        log(`[Enhanced-ASR] 🔍 Current client states - asrClient: ${!!asrClient}, gpt4oAsrClient: ${!!gpt4oAsrClient}, huggingFaceWhisperClient: ${!!huggingFaceWhisperClient}`);
        
        // Pre-warm ASR clients for faster startup
        if (!asrClient) {
            try {
                log(`[Enhanced-ASR] 🔍 Creating new Silero ASRClient...`);
                asrClient = new ASRClient({
                    onTranscription: async (chunk: ASRChunk) => {
                        if (chunk && chunk.text) {
                            await handleTranscription(chunk.text);
                        }
                    },
                    onError: async (error: Error) => {
                        if (error) {
                            await handleError(error);
                        }
                    },
                    onASRReady: async () => {
                        // Play ASR start sound when ASR is actually ready and working
                        try {
                            await playEarcon('asr_start', 0);
                            log('[Enhanced-ASR] Played ASR start sound (Silero ASR ready)');
                        } catch (error) {
                            log(`[Enhanced-ASR] Failed to play ASR start sound (Silero ASR ready): ${error}`);
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
                    onError: async (error: Error) => {
                        if (error) {
                            await handleError(error);
                        }
                    },
                    onRecordingStart: async () => {
                        // Play ASR start sound when GPT4o ASR is actually ready and working
                        try {
                            await playEarcon('asr_start', 0);
                            log('[Enhanced-ASR] Played ASR start sound (GPT4o ASR ready)');
                        } catch (error) {
                            log(`[Enhanced-ASR] Failed to play ASR start sound (GPT4o ASR ready): ${error}`);
                        }
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
        
        // Pre-warm Hugging Face Whisper client for faster startup
        if (!huggingFaceWhisperClient) {
            try {
                log(`[Enhanced-ASR] 🔍 Creating new Hugging Face Whisper ASRClient...`);
                huggingFaceWhisperClient = new HuggingFaceWhisperClient({
                    onTranscription: async (chunk: HuggingFaceWhisperChunk) => {
                        if (chunk && chunk.text) {
                            await handleTranscription(chunk.text);
                        }
                    },
                    onError: async (error: Error) => {
                        await handleASRError(error, 'Hugging Face Whisper ASR');
                    },
                    onRecordingStart: async () => {
                        await playEarcon('asr_start', 0);
                        log('[Enhanced-ASR] Played ASR start sound');
                    },
                    onRecordingStop: async () => {
                        await playEarcon('asr_stop', 0);
                        log('[Enhanced-ASR] Played ASR stop sound');
                    }
                });
                
                // Verify the client was created properly
                if (!huggingFaceWhisperClient || typeof huggingFaceWhisperClient !== 'object') {
                    throw new Error('HuggingFaceWhisperClient constructor returned invalid object');
                }
                
                log('[Enhanced-ASR] HuggingFaceWhisperClient initialized successfully');
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize HuggingFaceWhisperClient: ${error}`);
                huggingFaceWhisperClient = null; // Ensure it's explicitly null on failure
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
                try {
                    commandRouter?.addPattern({
                        pattern: /^(go\s*to\s*error|jump\s*to\s*error|navigate\s*to\s*error)$/i,
                        command: 'lipcoder.goToErrorLine',
                        description: 'Go to last detected error line'
                    });
                } catch (e) {
                    logWarning(`[Enhanced-ASR] Failed to add go-to-error pattern: ${e}`);
                }
            } catch (error) {
                logError(`[Enhanced-ASR] Failed to initialize CommandRouter: ${error}`);
                commandRouter = null; // Ensure it's explicitly null on failure
            }
        }
        
        // Final verification
        const initialized = {
            asrClient: !!asrClient,
            gpt4oAsrClient: !!gpt4oAsrClient,
            huggingFaceWhisperClient: !!huggingFaceWhisperClient,
            asrPopup: !!asrPopup,
            commandRouter: !!commandRouter
        };
        
        log(`[Enhanced-ASR] Initialization status: ${JSON.stringify(initialized)}`);
        
        if (!asrClient && !gpt4oAsrClient && !huggingFaceWhisperClient) {
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
 * Handle transcription result with conversational flow
 */
async function handleTranscription(text: string): Promise<void> {
    const startTime = Date.now();
    log(`[Enhanced-ASR] ================================================`);
    log(`[Enhanced-ASR] Transcription received: "${text}" (Mode: ${currentASRMode})`);
    log(`[Enhanced-ASR] Text length: ${text.length}`);
    log(`[Enhanced-ASR] Current mode: ${currentASRMode}`);
    log(`[Enhanced-ASR] Command router available: ${!!commandRouter}`);
    
    // Update popup immediately for faster feedback
    if (asrPopup) {
        asrPopup.updateTranscription(text);
    }
    
    // Output to channel (non-blocking)
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${text} (${currentASRMode} mode)`);
    }
    
    // Check for cached responses first for instant execution
    try {
        const { getCachedASRResponse } = await import('./asr_speed_optimizer.js');
        const cachedResponse = getCachedASRResponse(text);
        
        if (cachedResponse) {
            log(`[Enhanced-ASR] ⚡ Using cached response for instant execution`);
            
            // Execute cached command immediately
            if (currentASRMode === ASRMode.Command) {
                await vscode.commands.executeCommand(cachedResponse);
                const processingTime = Date.now() - startTime;
                log(`[Enhanced-ASR] ✅ Cached command executed in ${processingTime}ms`);
                return;
            }
        }
    } catch (error) {
        log(`[Enhanced-ASR] Cache check failed, proceeding with normal flow: ${error}`);
    }
    
    // Process through conversational flow (unified approach)
    try {
        log(`[Enhanced-ASR] 🤖 Processing through conversational ASR...`);
        
        // Import conversational modules
        const { processConversationalASR } = await import('../conversational_asr.js');
        const { showConversationalResponse } = await import('../conversational_popup.js');
        
        // Process transcription through conversational flow
        const mode = currentASRMode === ASRMode.Command ? 'command' : 'write';
        const conversationalResponse = await processConversationalASR(text, { mode });
        
        // Cache successful command responses for future use
        if (currentASRMode === ASRMode.Command && conversationalResponse.actions.length > 0) {
            try {
                const { cacheASRResponse } = await import('./asr_speed_optimizer.js');
                const firstAction = conversationalResponse.actions[0];
                if (firstAction.command) {
                    cacheASRResponse(text, firstAction.command);
                }
            } catch (error) {
                log(`[Enhanced-ASR] Failed to cache response: ${error}`);
            }
        }
        
        // Show conversational response with action options (only if there are actions to display)
        const shouldShowPopup = conversationalResponse.response && 
                               conversationalResponse.response.trim() !== "" && 
                               conversationalResponse.actions.length > 0; // Only show popup if there are actions to display
        
        if (shouldShowPopup) {
            await showConversationalResponse(conversationalResponse);
            const processingTime = Date.now() - startTime;
            log(`[Enhanced-ASR] ✅ Conversational processing complete in ${processingTime}ms: "${conversationalResponse.response}"`);
        } else {
            const processingTime = Date.now() - startTime;
            if (conversationalResponse.response && conversationalResponse.response.trim() !== "") {
                // If there's a response but no actions (navigation/success feedback), just log it
                log(`[Enhanced-ASR] ✅ Command completed with audio feedback in ${processingTime}ms: "${conversationalResponse.response}"`);
            } else {
                log(`[Enhanced-ASR] ✅ Command completed silently in ${processingTime}ms`);
            }
        }
        
        // For write mode, if no specific actions were suggested, fall back to text insertion
        if (currentASRMode === ASRMode.Write) {
            const hasTextInsertionAction = conversationalResponse.actions.some(
                (action: any) => action.command === 'insertText' || action.command === 'continueEditing'
            );
            
            if (!hasTextInsertionAction) {
                // The conversational system didn't suggest text insertion, so do it directly
                await handleDirectTextInsertion(text);
                log(`[Enhanced-ASR] Added direct text insertion for write mode`);
            }
        }
        
    } catch (error) {
        logError(`[Enhanced-ASR] Conversational processing failed, using minimal fallback: ${error}`);
        
        // Minimal fallback: just show the transcription and handle write mode
        if (currentASRMode === ASRMode.Write) {
            await handleDirectTextInsertion(text);
        } else {
            vscode.window.showInformationMessage(`ASR: ${text}`);
        }
        
        const processingTime = Date.now() - startTime;
        log(`[Enhanced-ASR] Fallback processing completed in ${processingTime}ms`);
    }
}

/**
 * Handle direct text insertion (fallback for write mode)
 */
async function handleDirectTextInsertion(text: string): Promise<void> {
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
    
    // Fallback to current active editor using enhanced tracking
    if (!targetEditor) {
        targetEditor = isEditorActive() || undefined;
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
            
            const fileName = targetEditor.document.fileName ? path.basename(targetEditor.document.fileName) : 'untitled';
            log(`[Enhanced-ASR] Text inserted in ${fileName} at line ${insertPosition.line + 1}`);
            
            // Show subtle notification
            vscode.window.showInformationMessage(`Text inserted: ${text}`);
        } catch (error) {
            logError(`[Enhanced-ASR] Error inserting text: ${error}`);
            vscode.window.showErrorMessage(`Failed to insert text: ${error}`);
        }
    } else {
        logWarning('[Enhanced-ASR] No editor available for text insertion');
        vscode.window.showWarningMessage('No editor available to insert transcribed text');
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
 * Handle errors
 */
async function handleError(error: Error): Promise<void> {
    // Use enhanced error handler with TTS and popup
    await handleASRError(error, 'Enhanced ASR');
    
    // Show error in ASR popup if available
    if (asrPopup) {
        asrPopup.showError(error.message);
    }
    
    // Stop recording on error
    if (isRecording) {
        stopRecording();
    }
}



/**
 * Get editor context with fallback to last known editor
 */
function getEditorContextWithFallback(): EditorContext | null {
    // Try to get current active editor first
    const editor = isEditorActive();
    if (editor) {
        const currentContext = {
            editor: editor,
            position: editor.selection.active,
            selection: editor.selection,
            documentUri: editor.document.uri
        };
        lastKnownEditorContext = currentContext;
        return currentContext;
    }
    
    // Use the enhanced last editor tracking as additional fallback
    const lastEditor = getLastActiveEditor();
    if (lastEditor) {
        try {
            // Check if the document is still open and valid
            if (!lastEditor.document.isClosed) {
                log('[Enhanced-ASR] Using last active editor from tracking system as fallback');
                const fallbackContext = {
                    editor: lastEditor,
                    position: lastEditor.selection.active,
                    selection: lastEditor.selection,
                    documentUri: lastEditor.document.uri
                };
                lastKnownEditorContext = fallbackContext;
                return fallbackContext;
            }
        } catch (error) {
            log(`[Enhanced-ASR] Last active editor is no longer valid: ${error}`);
        }
    }
    
    // Fallback to last known editor context if it's still valid
    if (lastKnownEditorContext) {
        try {
            // Check if the document is still open and valid
            if (!lastKnownEditorContext.editor.document.isClosed) {
                log('[Enhanced-ASR] Using last known editor context as final fallback');
                return lastKnownEditorContext;
            }
        } catch (error) {
            log(`[Enhanced-ASR] Last known editor context is no longer valid: ${error}`);
            lastKnownEditorContext = null;
        }
    }
    
    return null;
}

/**
 * Start recording in command mode
 */
async function startASRCommandMode(): Promise<void> {
    // Stop any ongoing audio/token reading immediately
    stopAllAudio();
    log(`[Enhanced-ASR] Stopped all audio for command mode recording`);
    
    // Set ASR recording flag to prevent token reading from starting
    setASRRecordingActive(true);
    log(`[Enhanced-ASR] Set ASR recording flag to prevent token reading`);
    
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
        
        // Clear ASR recording flag to allow token reading again
        setASRRecordingActive(false);
        log(`[Enhanced-ASR] Cleared ASR recording flag - token reading can resume`);
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
    
    // Set ASR recording flag to prevent token reading from starting
    setASRRecordingActive(true);
    log(`[Enhanced-ASR] Set ASR recording flag to prevent token reading`);
    
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
        
        // Clear ASR recording flag to allow token reading again
        setASRRecordingActive(false);  
        log(`[Enhanced-ASR] Cleared ASR recording flag - token reading can resume`);
    } else {
        logWarning(`[Enhanced-ASR] Cannot stop write mode - current mode is ${currentASRMode}`);
    }
}

/**
 * Start recording
 */
async function startRecording(): Promise<void> {
    logSuccess('🔴 [ASR-DEBUG] startRecording() function called!');
    
    if (isRecording) {
        logWarning('[Enhanced-ASR] Already recording');
        return;
    }
    
    try {
        log('[Enhanced-ASR] Starting ASR recording...');
        logSuccess('🔴 [ASR-DEBUG] About to initialize ASR client...');
        
        // Stop all ongoing audio/token reading before starting recording
        stopAllAudio();
        log('[Enhanced-ASR] Stopped all ongoing audio before recording');
        
        // Capture editor context at the start of recording with fallback
        recordingContext = getEditorContextWithFallback();
        if (recordingContext) {
            log(`[Enhanced-ASR] Captured context: ${recordingContext.documentUri.fsPath} at line ${recordingContext.position.line + 1}`);
        } else {
            logWarning('[Enhanced-ASR] No active editor context available (no fallback available)');
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
        logSuccess(`🔴 [ASR-DEBUG] Current backend: ${currentASRBackend}`);
        logSuccess(`🔴 [ASR-DEBUG] GPT4o client exists: ${!!gpt4oAsrClient}`);
        logSuccess(`🔴 [ASR-DEBUG] Silero client exists: ${!!asrClient}`);
        logSuccess(`🔴 [ASR-DEBUG] HuggingFace Whisper client exists: ${!!huggingFaceWhisperClient}`);
        
        if (currentASRBackend === ASRBackend.GPT4o && gpt4oAsrClient && typeof gpt4oAsrClient === 'object') {
            logSuccess('🔴 [ASR-DEBUG] Using GPT4o backend...');
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
            logSuccess('🔴 [ASR-DEBUG] Using Silero backend...');
            logSuccess(`🔴 [ASR-DEBUG] ASR client type: ${typeof asrClient}, has startStreaming: ${typeof asrClient.startStreaming}`);
            try {
                if (typeof asrClient.startStreaming === 'function') {
                    logSuccess('🔴 [ASR-DEBUG] Calling asrClient.startStreaming()...');
                    await asrClient.startStreaming();
                    logSuccess('🔴 [ASR-DEBUG] asrClient.startStreaming() completed successfully');
                    handleRecordingStart(); // Manual call for Silero
                    logSuccess('🔴 [ASR-DEBUG] handleRecordingStart() completed');
                } else {
                    throw new Error('Silero ASR client startStreaming method not available');
                }
            } catch (error) {
                logError(`🔴 [ASR-DEBUG] Error in Silero ASR: ${error}`);
                throw new Error(`Failed to start Silero ASR recording: ${error}`);
            }
        } else if (currentASRBackend === ASRBackend.HuggingFaceWhisper && huggingFaceWhisperClient && typeof huggingFaceWhisperClient === 'object') {
            logSuccess('🔴 [ASR-DEBUG] Using Hugging Face Whisper backend...');
            logSuccess(`🔴 [ASR-DEBUG] HF Whisper client type: ${typeof huggingFaceWhisperClient}, has startRecording: ${typeof huggingFaceWhisperClient.startRecording}`);
            try {
                if (typeof huggingFaceWhisperClient.startRecording === 'function') {
                    logSuccess('🔴 [ASR-DEBUG] Calling huggingFaceWhisperClient.startRecording()...');
                    await huggingFaceWhisperClient.startRecording();
                    handleRecordingStart(); // Manual call for Hugging Face Whisper
                } else {
                    throw new Error('Hugging Face Whisper ASR client startRecording method not available');
                }
            } catch (error) {
                logError(`🔴 [ASR-DEBUG] Error in Hugging Face Whisper ASR: ${error}`);
                throw new Error(`Failed to start Hugging Face Whisper ASR recording: ${error}`);
            }
        } else {
            const availableClients = {
                gpt4o: !!gpt4oAsrClient,
                silero: !!asrClient,
                huggingFaceWhisper: !!huggingFaceWhisperClient,
                currentBackend: currentASRBackend
            };
            throw new Error(`ASR backend ${currentASRBackend} not available or not initialized. Status: ${JSON.stringify(availableClients)}`);
        }
        
        logSuccess('[Enhanced-ASR] Recording started successfully');
        
    } catch (error) {
        logError(`🔴 [ASR-DEBUG] Error in startRecording(): ${error}`);
        console.error('🔴 [ASR-DEBUG] Error in startRecording():', error);
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
        } else if (currentASRBackend === ASRBackend.HuggingFaceWhisper && huggingFaceWhisperClient && typeof huggingFaceWhisperClient === 'object') {
            try {
                if (typeof huggingFaceWhisperClient.stopRecording === 'function') {
                    await huggingFaceWhisperClient.stopRecording();
                    handleRecordingStop(); // Manual call for Hugging Face Whisper
                } else {
                    logError('[Enhanced-ASR] Hugging Face Whisper ASR client stopRecording method not available');
                }
            } catch (error) {
                logError(`[Enhanced-ASR] Error stopping Hugging Face Whisper recording: ${error}`);
            }
        } else {
            logWarning(`[Enhanced-ASR] No valid ASR client available to stop for backend: ${currentASRBackend}`);
        }
        
        // Play ASR stop sound
        try {
            await playEarcon('asr_stop', 0);
            log('[Enhanced-ASR] Played ASR stop sound');
        } catch (error) {
            log(`[Enhanced-ASR] Failed to play ASR stop sound: ${error}`);
        }
        
        logSuccess('[Enhanced-ASR] Recording stopped successfully');
        
    } catch (error) {
        handleError(error as Error);
    }
}

/**
 * Handle recording start callback
 */
function handleRecordingStart(): void {
    log('[Enhanced-ASR] Recording started - setting up UI state');
    isRecording = true;
    setASRRecordingActive(true);
    setRecordingContextKey(true); // Set VS Code context for key bindings
    
    // Update status bar
    updateStatusBar(true);
    
    // Clear any auto-stop timer
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    
    // Set auto-stop timer for safety
    autoStopTimer = setTimeout(async () => {
        logWarning('[Enhanced-ASR] Auto-stopping recording after maximum duration');
        await stopRecording();
    }, MAX_RECORDING_DURATION);
    
    // Capture editor context when recording starts
    const editor = isEditorActive();
    if (editor) {
        recordingContext = {
            editor: editor,
            position: editor.selection.active,
            selection: editor.selection,
            documentUri: editor.document.uri
        };
        lastKnownEditorContext = recordingContext;
    }
    
    log('[Enhanced-ASR] Recording state initialized');
}

/**
 * Handle recording stop callback
 */
function handleRecordingStop(): void {
    log('[Enhanced-ASR] Recording stopped - cleaning up UI state');
    isRecording = false;
    setASRRecordingActive(false);
    setRecordingContextKey(false); // Clear VS Code context for key bindings
    
    // Update status bar
    updateStatusBar(false);
    
    // Clear auto-stop timer
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    
    log('[Enhanced-ASR] Recording state cleaned up');
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
 * Capture current editor context
 */
function captureEditorContext(): void {
    try {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            recordingContext = {
                editor: activeEditor,
                position: activeEditor.selection.active,
                selection: activeEditor.selection,
                documentUri: activeEditor.document.uri
            };
            lastKnownEditorContext = recordingContext; // Also update last known
            log(`[Enhanced-ASR] Captured editor context: ${activeEditor.document.fileName}`);
        } else {
            recordingContext = null;
            log('[Enhanced-ASR] No active editor to capture context from');
        }
    } catch (error) {
        logError(`[Enhanced-ASR] Failed to capture editor context: ${error}`);
        recordingContext = null;
    }
}

/**
 * Update status bar item
 */
function updateStatusBar(recording: boolean): void {
    try {
        if (!statusBarItem) {
            statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            statusBarItem.command = 'lipcoder.toggleEnhancedASR';
        }
        
        if (recording) {
            statusBarItem.text = `$(record) ASR Recording (${currentASRBackend})`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = 'ASR is recording - click to stop';
        } else {
            statusBarItem.text = `$(mic) ASR Ready (${currentASRBackend})`;
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = 'Click to start ASR recording';
        }
        
        statusBarItem.show();
    } catch (error) {
        logError(`[Enhanced-ASR] Failed to update status bar: ${error}`);
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
        
        // Listen for active editor changes to keep track of last known editor
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) {
                    // Update last known editor context whenever editor changes
                    captureEditorContext();
                    log(`[Enhanced-ASR] Updated last known editor context: ${editor.document.fileName}`);
                }
            })
        );
        
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
        outputChannel = vscode.window.createOutputChannel('LipCoder Enhanced ASR', {log:true});
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

        vscode.commands.registerCommand('lipcoder.goToErrorLine', async () => {
            await goToLastDetectedError();
        }),
        
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
            
            if (!pattern) {
                return;
            }
            
            const command = await vscode.window.showInputBox({
                prompt: 'Enter VS Code command to execute',
                placeHolder: 'workbench.action.closeActiveEditor'
            });
            
            if (!command) {
                return;
            }
            
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
             
             if (!functionName) {
                 return;
             }
             
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
             
             if (!scriptName) {
                 return;
             }
             
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