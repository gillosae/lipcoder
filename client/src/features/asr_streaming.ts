import * as vscode from 'vscode';
import { ASRClient, ASRChunk } from '../asr';
import { log } from '../utils';

let asrClient: ASRClient | null = null;
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Get the current ASRClient instance for cleanup
 */
export function getASRClient(): ASRClient | null {
    return asrClient;
}

export function registerASRStreaming(context: vscode.ExtensionContext) {
    // Create output channel for transcription
    outputChannel = vscode.window.createOutputChannel('LipCoder ASR');

    // Register start ASR streaming command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.startASRStreaming', async () => {
            try {
                if (asrClient && asrClient.getRecordingStatus()) {
                    vscode.window.showInformationMessage('ASR streaming is already active');
                    return;
                }

                log('[ASR] Starting ASR streaming...');
                vscode.window.showInformationMessage('Starting ASR streaming...');

                asrClient = new ASRClient({
                    chunkDuration: 2000, // 2 seconds per chunk
                    sampleRate: 16000,
            
                    onTranscription: (chunk: ASRChunk) => {
                        const timestamp = new Date(chunk.timestamp).toLocaleTimeString();
                        const message = `[${timestamp}] ${chunk.text}`;
                        
                        log(`[ASR] Transcription: ${chunk.text}`);
                        outputChannel?.appendLine(message);
                        
                        // Show notification for each transcription
                        vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
                    },
                    onError: (error: Error) => {
                        log(`[ASR] Error: ${error.message}`);
                        vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
                    }
                });

                await asrClient.startStreaming();
                vscode.window.showInformationMessage('ASR streaming started successfully');

            } catch (error) {
                log(`[ASR] Failed to start streaming: ${error}`);
                vscode.window.showErrorMessage(`Failed to start ASR streaming: ${error}`);
            }
        })
    );

    // Register stop ASR streaming command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.stopASRStreaming', () => {
            if (asrClient && asrClient.getRecordingStatus()) {
                asrClient.stopStreaming();
                asrClient = null;
                vscode.window.showInformationMessage('ASR streaming stopped');
                log('[ASR] Streaming stopped');
            } else {
                vscode.window.showInformationMessage('ASR streaming is not active');
            }
        })
    );

    // Register toggle ASR streaming command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.toggleASRStreaming', async () => {
            if (asrClient && asrClient.getRecordingStatus()) {
                vscode.commands.executeCommand('lipcoder.stopASRStreaming');
            } else {
                vscode.commands.executeCommand('lipcoder.startASRStreaming');
            }
        })
    );

    // Register show ASR output command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.showASROutput', () => {
            if (outputChannel) {
                outputChannel.show();
            }
        })
    );

    // Register clear ASR output command
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.clearASROutput', () => {
            if (outputChannel) {
                outputChannel.clear();
                vscode.window.showInformationMessage('ASR output cleared');
            }
        })
    );

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (asrClient) {
                if (asrClient.getRecordingStatus()) {
                    asrClient.stopStreaming();
                }
                asrClient.dispose();
                asrClient = null;
            }
            outputChannel?.dispose();
            outputChannel = null;
        }
    });
} 