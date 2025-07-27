import * as vscode from 'vscode';
import { ASRClient, ASRChunk } from '../asr';
import { log } from '../utils';

/**
 * Register the toggle ASR command
 */
export function registerToggleASR(context: vscode.ExtensionContext) {
    log('[Toggle ASR] Registering toggle ASR command');
    
    let asrClient: ASRClient | null = null;
    let statusBarItem: vscode.StatusBarItem | null = null;
    let outputChannel: vscode.OutputChannel | null = null;
    
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(mic) ASR';
    statusBarItem.tooltip = 'Click to toggle ASR streaming';
    statusBarItem.command = 'lipcoder.toggleASR';
    statusBarItem.show();
    
    // Create output channel
    outputChannel = vscode.window.createOutputChannel('ASR Streaming');
    
    const toggleCommand = vscode.commands.registerCommand('lipcoder.toggleASR', async () => {
        try {
            log('[Toggle ASR] Toggle ASR command executed');
            
            if (!asrClient || !asrClient.getRecordingStatus()) {
                // Start ASR streaming
                log('[Toggle ASR] Starting ASR streaming...');
                
                asrClient = new ASRClient({
                    chunkDuration: 2000,
                    sampleRate: 16000,
                    serverUrl: 'http://localhost:5005/asr',
                    onTranscription: (chunk) => {
                        log(`[Toggle ASR] Transcription received: "${chunk.text}"`);
                        vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
                        if (outputChannel) {
                            outputChannel.appendLine(`[${new Date().toISOString()}] ${chunk.text}`);
                        }
                    },
                    onError: (error) => {
                        log(`[Toggle ASR] ASR error: ${error.message}`);
                        vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
                    }
                });
                
                await asrClient.startStreaming();
                log('[Toggle ASR] ASR streaming started');
                
                if (statusBarItem) {
                    statusBarItem.text = '$(mic) ASR ON';
                    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                }
                
            } else {
                // Stop ASR streaming
                log('[Toggle ASR] Stopping ASR streaming...');
                
                asrClient.stopStreaming();
                asrClient = null;
                log('[Toggle ASR] ASR streaming stopped');
                
                if (statusBarItem) {
                    statusBarItem.text = '$(mic) ASR';
                    statusBarItem.backgroundColor = undefined;
                }
            }
            
        } catch (error) {
            log(`[Toggle ASR] Error in toggle command: ${error}`);
            vscode.window.showErrorMessage(`Toggle ASR Error: ${error}`);
        }
    });
    
    // Register toggle ASR streaming command
    const toggleASRStreamingCommand = vscode.commands.registerCommand('lipcoder.toggleASRStreaming', async () => {
        try {
            log('[Toggle ASR] Toggle ASR Streaming command executed');
            
            if (!asrClient || !asrClient.getRecordingStatus()) {
                // Start ASR streaming
                log('[Toggle ASR] Starting ASR streaming via toggle streaming command...');
                
                asrClient = new ASRClient({
                    chunkDuration: 2000,
                    sampleRate: 16000,
                    serverUrl: 'http://localhost:5005/asr',
                    onTranscription: (chunk) => {
                        log(`[Toggle ASR] Toggle Streaming Transcription received: "${chunk.text}"`);
                        vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
                        if (outputChannel) {
                            outputChannel.appendLine(`[${new Date().toISOString()}] ${chunk.text}`);
                        }
                    },
                    onError: (error) => {
                        log(`[Toggle ASR] Toggle Streaming ASR error: ${error.message}`);
                        vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
                    }
                });
                
                await asrClient.startStreaming();
                log('[Toggle ASR] ASR streaming started via toggle streaming command');
                
                if (statusBarItem) {
                    statusBarItem.text = '$(mic) ASR ON';
                    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                }
                
            } else {
                // Stop ASR streaming
                log('[Toggle ASR] Stopping ASR streaming via toggle streaming command...');
                
                asrClient.stopStreaming();
                asrClient = null;
                log('[Toggle ASR] ASR streaming stopped via toggle streaming command');
                
                if (statusBarItem) {
                    statusBarItem.text = '$(mic) ASR';
                    statusBarItem.backgroundColor = undefined;
                }
            }
            
        } catch (error) {
            log(`[Toggle ASR] Error in toggle ASR streaming command: ${error}`);
            vscode.window.showErrorMessage(`Toggle ASR Streaming Error: ${error}`);
        }
    });
    
    // Register additional commands
    const showOutputCommand = vscode.commands.registerCommand('lipcoder.showASROutput', () => {
        if (outputChannel) {
            outputChannel.show();
        }
    });
    
    const clearOutputCommand = vscode.commands.registerCommand('lipcoder.clearASROutput', () => {
        if (outputChannel) {
            outputChannel.clear();
        }
    });
    
    const getStatusCommand = vscode.commands.registerCommand('lipcoder.getASRStatus', () => {
        const isRecording = asrClient ? asrClient.getRecordingStatus() : false;
        const status = isRecording ? 'Recording' : 'Stopped';
        vscode.window.showInformationMessage(`ASR Status: ${status}`);
    });
    
    const openTestPageCommand = vscode.commands.registerCommand('lipcoder.openASRTestPage', () => {
        const testPagePath = vscode.Uri.file(vscode.workspace.workspaceFolders![0].uri.fsPath + '/client/test_asr.html');
        vscode.env.openExternal(testPagePath);
    });
    
    const testServerCommand = vscode.commands.registerCommand('lipcoder.testASRServer', async () => {
        if (asrClient) {
            const isConnected = await asrClient.testServerConnection();
            const status = isConnected ? 'Connected' : 'Not Connected';
            vscode.window.showInformationMessage(`ASR Server: ${status}`);
        } else {
            vscode.window.showErrorMessage('ASR client not initialized');
        }
    });
    
    // Register start ASR streaming command
    const startASRCommand = vscode.commands.registerCommand('lipcoder.startASRStreaming', async () => {
        try {
            log('[Toggle ASR] Start ASR streaming command executed');
            
            if (asrClient && asrClient.getRecordingStatus()) {
                vscode.window.showInformationMessage('ASR is already running');
                return;
            }
            
            asrClient = new ASRClient({
                chunkDuration: 2000,
                sampleRate: 16000,
                serverUrl: 'http://localhost:5005/asr',
                onTranscription: (chunk) => {
                    log(`[Toggle ASR] Start ASR Transcription received: "${chunk.text}"`);
                    vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
                    if (outputChannel) {
                        outputChannel.appendLine(`[${new Date().toISOString()}] ${chunk.text}`);
                    }
                },
                onError: (error) => {
                    log(`[Toggle ASR] Start ASR error: ${error.message}`);
                    vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
                }
            });
            
            await asrClient.startStreaming();
            log('[Toggle ASR] ASR streaming started via start command');
            
            if (statusBarItem) {
                statusBarItem.text = '$(mic) ASR ON';
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            }
            
        } catch (error) {
            log(`[Toggle ASR] Error in start ASR command: ${error}`);
            vscode.window.showErrorMessage(`Start ASR Error: ${error}`);
        }
    });
    
    // Register stop ASR streaming command
    const stopASRCommand = vscode.commands.registerCommand('lipcoder.stopASRStreaming', () => {
        try {
            log('[Toggle ASR] Stop ASR streaming command executed');
            
            if (!asrClient || !asrClient.getRecordingStatus()) {
                vscode.window.showInformationMessage('ASR is not running');
                return;
            }
            
            asrClient.stopStreaming();
            asrClient = null;
            log('[Toggle ASR] ASR streaming stopped via stop command');
            
            if (statusBarItem) {
                statusBarItem.text = '$(mic) ASR';
                statusBarItem.backgroundColor = undefined;
            }
            
        } catch (error) {
            log(`[Toggle ASR] Error in stop ASR command: ${error}`);
            vscode.window.showErrorMessage(`Stop ASR Error: ${error}`);
        }
    });
    
    // Register test transcription command
    const testTranscriptionCommand = vscode.commands.registerCommand('lipcoder.testTranscription', () => {
        if (asrClient) {
            asrClient.simulateTranscription("This is a test transcription from the VS Code extension");
            log('[Toggle ASR] Test transcription triggered');
        } else {
            vscode.window.showErrorMessage('ASR client not initialized');
        }
    });
    
    // Register simulate audio processing command
    const simulateAudioCommand = vscode.commands.registerCommand('lipcoder.simulateAudioProcessing', async () => {
        if (asrClient) {
            await asrClient.simulateAudioProcessing("This is simulated audio processing from the VS Code extension");
            log('[Toggle ASR] Simulated audio processing triggered');
        } else {
            vscode.window.showErrorMessage('ASR client not initialized');
        }
    });
    
    // Add commands to context
    context.subscriptions.push(
        toggleCommand,
        toggleASRStreamingCommand,
        showOutputCommand,
        clearOutputCommand,
        getStatusCommand,
        openTestPageCommand,
        testServerCommand,
        startASRCommand,
        stopASRCommand,
        testTranscriptionCommand,
        simulateAudioCommand
    );
    
    // Cleanup function
    const cleanup = () => {
        log('[Toggle ASR] Cleaning up toggle ASR feature');
        if (asrClient) {
            asrClient.stopStreaming();
        }
        if (statusBarItem) {
            statusBarItem.dispose();
        }
        if (outputChannel) {
            outputChannel.dispose();
        }
    };
    
    context.subscriptions.push({ dispose: cleanup });
    
    log('[Toggle ASR] Toggle ASR feature registered successfully');
} 