import * as vscode from 'vscode';
import { ASRClient, ASRChunk } from '../asr';
import { log } from '../utils';

let asrClient: ASRClient | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let isRecording = false;
let recordingTimeout: NodeJS.Timeout | null = null;
let simulationTimeouts: NodeJS.Timeout[] = [];

/**
 * Get the current ASRClient instance for cleanup
 */
export function getASRClient(): ASRClient | null {
    return asrClient;
}

/**
 * Clean up all push-to-talk resources
 */
function cleanupPushToTalk(): void {
    if (recordingTimeout) {
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
    }
    
    // Clear all simulation timeouts
    simulationTimeouts.forEach(timeout => clearTimeout(timeout));
    simulationTimeouts = [];
    
    log('[PushToTalk] Cleaned up all timers and resources');
}

export function registerPushToTalkASR(context: vscode.ExtensionContext) {
    log('[ASR] Registering push-to-talk ASR commands');
    
    // Create output channel for transcription
    outputChannel = vscode.window.createOutputChannel('LipCoder Push-to-Talk ASR');
    log('[ASR] Created output channel: LipCoder Push-to-Talk ASR');

    // Create status bar item to show ASR status
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBarItem.command = 'lipcoder.pushToTalkASR';
    statusBarItem.tooltip = 'Push-to-Talk ASR (Hold key to record)';
    updateStatusBar(false);
    statusBarItem.show();
    log('[ASR] Created status bar item for push-to-talk ASR');

    // Register push-to-talk ASR command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.pushToTalkASR', async () => {
            try {
                log('[ASR] Push-to-talk ASR command executed');
                
                if (isRecording) {
                    // Stop recording
                    log('[ASR] Stopping push-to-talk recording');
                    stopRecording();
                } else {
                    // Start recording
                    log('[ASR] Starting push-to-talk recording');
                    await startRecording();
                }
            } catch (error) {
                log(`[ASR] Failed to toggle push-to-talk: ${error}`);
                vscode.window.showErrorMessage(`Failed to toggle push-to-talk ASR: ${error}`);
                updateStatusBar(false);
            }
        })
    );

    // Register start recording command (for key down)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.startRecording', async () => {
            log('[ASR] Start recording command executed (key down)');
            if (!isRecording) {
                log('[ASR] Starting recording from key down event');
                await startRecording();
            } else {
                log('[ASR] Recording already active, ignoring key down');
            }
        })
    );

    // Register stop recording command (for key up)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.stopRecording', () => {
            log('[ASR] Stop recording command executed (key up)');
            if (isRecording) {
                log('[ASR] Stopping recording from key up event');
                stopRecording();
            } else {
                log('[ASR] No active recording to stop');
            }
        })
    );

    // Register show ASR output command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.showPushToTalkOutput', () => {
            log('[ASR] Show push-to-talk output command executed');
            if (outputChannel) {
                outputChannel.show();
                log('[ASR] Push-to-talk output channel shown');
            }
        })
    );

    // Register clear ASR output command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.clearPushToTalkOutput', () => {
            log('[ASR] Clear push-to-talk output command executed');
            if (outputChannel) {
                outputChannel.clear();
                vscode.window.showInformationMessage('Push-to-Talk ASR output cleared');
                log('[ASR] Push-to-talk output cleared');
            }
        })
    );

    // Register get ASR status command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.getPushToTalkStatus', () => {
            log('[ASR] Get push-to-talk status command executed');
            const status = isRecording ? 'Recording' : 'Stopped';
            vscode.window.showInformationMessage(`Push-to-Talk ASR Status: ${status}`);
            log(`[ASR] Push-to-talk status reported: ${status}`);
            return isRecording;
        })
    );

    // Register open browser test page command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openPushToTalkTestPage', () => {
            log('[ASR] Open push-to-talk test page command executed');
            vscode.env.openExternal(vscode.Uri.parse('http://localhost:8080/test_asr.html'));
            log('[ASR] Push-to-talk test page opened in browser');
        })
    );

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            cleanupPushToTalk();
            
            if (asrClient) {
                if (asrClient.getRecordingStatus()) {
                    asrClient.stopStreaming();
                }
                asrClient.dispose();
                asrClient = null;
            }
        }
    });
    
    log('[ASR] Push-to-talk ASR commands registered successfully');
}

async function startRecording() {
    try {
        log('[ASR] Starting push-to-talk recording...');
        
        // Show instructions for browser-based ASR
        const message = 'Push-to-Talk ASR requires browser access. Please:\n\n' +
            '1. Open http://localhost:8080/test_asr.html\n' +
            '2. Click "Start ASR Streaming" in the browser\n' +
            '3. Grant microphone permissions\n' +
            '4. Hold the shortcut key while speaking\n' +
            '5. Release the key to stop recording\n\n' +
            'VS Code will show notifications for transcriptions.';
        
        vscode.window.showInformationMessage(message);
        log('[ASR] Shown browser instructions for push-to-talk');
        
        // Create a simulated ASR client for status tracking
        asrClient = new ASRClient({
            chunkDuration: 2000,
            sampleRate: 16000,
            serverUrl: 'http://localhost:5005/asr',
            onTranscription: (chunk: ASRChunk) => {
                const timestamp = new Date(chunk.timestamp).toLocaleTimeString();
                const message = `[${timestamp}] ${chunk.text}`;
                
                log(`[ASR] Push-to-Talk Transcription received: "${chunk.text}"`);
                log(`[ASR] Push-to-Talk Transcription timestamp: ${timestamp}`);
                outputChannel?.appendLine(message);
                
                // Show notification for each transcription
                vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
                log(`[ASR] Push-to-Talk Transcription notification shown: "${chunk.text}"`);
            },
            onError: (error: Error) => {
                log(`[ASR] Push-to-Talk Error: ${error.message}`);
                vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
                updateStatusBar(false);
            }
        });

        // Simulate starting (since actual audio capture is in browser)
        await asrClient.startStreaming();
        isRecording = true;
        updateStatusBar(true);
        vscode.window.showInformationMessage('Push-to-Talk ASR started (browser-based)');
        log('[ASR] Push-to-Talk recording started');

        // Simulate some audio processing for testing
        const timeout1 = setTimeout(async () => {
            if (isRecording && asrClient && asrClient.getRecordingStatus()) {
                log('[ASR] Simulating push-to-talk audio processing after 1 second...');
                await asrClient.simulateAudioProcessing("Push to talk is working correctly");
            }
        }, 1000);
        simulationTimeouts.push(timeout1);

        // Simulate another transcription after 3 seconds
        const timeout2 = setTimeout(async () => {
            if (isRecording && asrClient && asrClient.getRecordingStatus()) {
                log('[ASR] Simulating second push-to-talk audio processing after 3 seconds...');
                await asrClient.simulateAudioProcessing("This is a second test transcription");
            }
        }, 3000);
        simulationTimeouts.push(timeout2);

        // Auto-stop after 10 seconds for safety
        recordingTimeout = setTimeout(() => {
            if (isRecording) {
                stopRecording();
                log('[ASR] Push-to-Talk recording auto-stopped after 10 seconds');
            }
        }, 10000);

    } catch (error) {
        log(`[ASR] Failed to start push-to-talk recording: ${error}`);
        throw error;
    }
}

function stopRecording() {
    log('[ASR] Stopping push-to-talk recording...');
    
    isRecording = false;
    
    if (recordingTimeout) {
        log('[ASR] Clearing auto-stop timeout');
        clearTimeout(recordingTimeout);
        recordingTimeout = null;
    }
    
    if (asrClient && asrClient.getRecordingStatus()) {
        log('[ASR] Stopping ASR client');
        asrClient.stopStreaming();
        asrClient = null;
    }
    
    updateStatusBar(false);
    vscode.window.showInformationMessage('Push-to-Talk ASR stopped');
    log('[ASR] Push-to-Talk recording stopped');
}

function updateStatusBar(isRecording: boolean) {
    log(`[ASR] Updating push-to-talk status bar: isRecording=${isRecording}`);
    if (statusBarItem) {
        if (isRecording) {
            statusBarItem.text = '$(mic) PTT ON';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            log('[ASR] Push-to-talk status bar updated to: PTT ON');
        } else {
            statusBarItem.text = '$(mic) PTT OFF';
            statusBarItem.backgroundColor = undefined;
            log('[ASR] Push-to-talk status bar updated to: PTT OFF');
        }
    }
} 