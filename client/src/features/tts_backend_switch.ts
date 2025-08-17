import * as vscode from 'vscode';
import { setBackend, TTSBackend, currentBackend, sileroConfig, espeakConfig, openaiTTSConfig } from '../config';
import { log, logSuccess, logWarning } from '../utils';
import { serverManager } from '../server_manager';

export function registerTTSBackendSwitch(context: vscode.ExtensionContext) {
    
    // Command to switch to Silero TTS
    const switchToSileroCommand = vscode.commands.registerCommand('lipcoder.switchToSilero', async () => {
        try {
            log('[TTS Backend] Switching to Silero TTS...');
            
            // First switch the TTS servers (kill current, start new)
            await serverManager.switchTTSBackend('silero');
            
            // Then update the config
            setBackend(TTSBackend.Silero);
            
            log('[TTS Backend] Successfully switched to Silero TTS');
            vscode.window.showInformationMessage('✅ TTS Backend switched to Silero');
            logSuccess(`TTS Backend: Silero (${sileroConfig.modelId}, speaker: ${sileroConfig.defaultSpeaker})`);
        } catch (error) {
            logWarning(`Failed to switch to Silero TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to switch to Silero TTS: ${error}`);
        }
    });

    // Command to switch to espeak-ng TTS
    const switchToEspeakCommand = vscode.commands.registerCommand('lipcoder.switchToEspeak', async () => {
        try {
            log('[TTS Backend] Switching to espeak-ng TTS...');
            
            // First switch the TTS servers (kill current, start new)
            await serverManager.switchTTSBackend('espeak');
            
            // Then update the config
            setBackend(TTSBackend.Espeak);
            
            log('[TTS Backend] Successfully switched to espeak-ng TTS');
            vscode.window.showInformationMessage('✅ TTS Backend switched to espeak-ng');
            logSuccess(`TTS Backend: espeak-ng (voice: ${espeakConfig.defaultVoice}, speed: ${espeakConfig.speed})`);
        } catch (error) {
            logWarning(`Failed to switch to espeak-ng TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to switch to espeak-ng TTS: ${error}`);
        }
    });

    // Command to switch to OpenAI TTS
    const switchToOpenAICommand = vscode.commands.registerCommand('lipcoder.switchToOpenAI', async () => {
        try {
            log('[TTS Backend] Switching to OpenAI TTS...');
            
            // OpenAI TTS doesn't need a server, it uses direct API calls
            // So we don't need to call serverManager.switchTTSBackend
            
            // Update the config
            setBackend(TTSBackend.OpenAI);
            
            log('[TTS Backend] Successfully switched to OpenAI TTS');
            vscode.window.showInformationMessage('✅ TTS Backend switched to OpenAI (Korean)');
            logSuccess(`TTS Backend: OpenAI (model: ${openaiTTSConfig.model}, voice: ${openaiTTSConfig.voice}, language: ${openaiTTSConfig.language})`);
        } catch (error) {
            logWarning(`Failed to switch to OpenAI TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to switch to OpenAI TTS: ${error}`);
        }
    });

    // Command to show current TTS backend status
    const showTTSStatusCommand = vscode.commands.registerCommand('lipcoder.showTTSStatus', async () => {
        let statusMessage: string;
        
        // Get server status to show if servers are running
        const serverStatus = serverManager.getServerStatus();
        const sileroRunning = serverStatus['tts']?.running || false;
        const espeakRunning = serverStatus['espeak_tts']?.running || false;
        
        if (currentBackend === TTSBackend.Silero) {
            statusMessage = `Current TTS Backend: Silero ${sileroRunning ? '(Running)' : '(Stopped)'}\nModel: ${sileroConfig.modelId}\nSpeaker: ${sileroConfig.defaultSpeaker}\nSample Rate: ${sileroConfig.sampleRate}Hz\nPort: ${serverStatus['tts']?.port || 'N/A'}`;
        } else if (currentBackend === TTSBackend.Espeak) {
            statusMessage = `Current TTS Backend: espeak-ng ${espeakRunning ? '(Running)' : '(Stopped)'}\nVoice: ${espeakConfig.defaultVoice}\nSpeed: ${espeakConfig.speed} WPM\nPitch: ${espeakConfig.pitch}\nSample Rate: ${espeakConfig.sampleRate}Hz\nPort: ${serverStatus['espeak_tts']?.port || 'N/A'}`;
        } else if (currentBackend === TTSBackend.OpenAI) {
            statusMessage = `Current TTS Backend: OpenAI (API-based)\nModel: ${openaiTTSConfig.model}\nVoice: ${openaiTTSConfig.voice}\nLanguage: ${openaiTTSConfig.language}\nSpeed: ${openaiTTSConfig.speed}x\nAPI Key: ${openaiTTSConfig.apiKey ? 'Configured' : 'Not configured'}`;
        } else {
            statusMessage = `Current TTS Backend: ${currentBackend} (unknown)`;
        }
        
        log(`[TTS Status] ${statusMessage.replace(/\n/g, ', ')}`);
        vscode.window.showInformationMessage(statusMessage);
    });

    // Command to select TTS backend from a quick pick menu
    const selectTTSBackendCommand = vscode.commands.registerCommand('lipcoder.selectTTSBackend', async () => {
        const serverStatus = serverManager.getServerStatus();
        const sileroRunning = serverStatus['tts']?.running || false;
        const espeakRunning = serverStatus['espeak_tts']?.running || false;
        
        const items = [
            {
                label: 'Silero TTS',
                description: `Neural TTS with multiple voices (current: ${sileroConfig.defaultSpeaker}) ${sileroRunning ? '- Running' : '- Stopped'}`,
                detail: 'High-quality neural text-to-speech with voice variety',
                backend: TTSBackend.Silero
            },
            {
                label: 'espeak-ng TTS',  
                description: `Fast system TTS (current: ${espeakConfig.defaultVoice}) ${espeakRunning ? '- Running' : '- Stopped'}`,
                detail: 'Lightweight and fast text-to-speech engine',
                backend: TTSBackend.Espeak
            },
            {
                label: 'OpenAI TTS (Korean)',
                description: `Cloud-based Korean TTS (current: ${openaiTTSConfig.voice}) ${openaiTTSConfig.apiKey ? '- Ready' : '- API key needed'}`,
                detail: 'High-quality Korean text-to-speech via OpenAI API',
                backend: TTSBackend.OpenAI
            }
        ];

        // Mark current backend
        const currentItem = items.find(item => item.backend === currentBackend);
        if (currentItem) {
            currentItem.label = `$(check) ${currentItem.label}`;
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select TTS Backend (will restart TTS server)',
            title: 'Choose Text-to-Speech Engine'
        });

        if (selected && selected.backend !== currentBackend) {
            try {
                log(`[TTS Backend] User selected: ${selected.backend}`);
                
                if (selected.backend === TTSBackend.Silero) {
                    await vscode.commands.executeCommand('lipcoder.switchToSilero');
                } else if (selected.backend === TTSBackend.Espeak) {
                    await vscode.commands.executeCommand('lipcoder.switchToEspeak');
                } else if (selected.backend === TTSBackend.OpenAI) {
                    await vscode.commands.executeCommand('lipcoder.switchToOpenAI');
                }
                
            } catch (error) {
                logWarning(`Failed to switch TTS backend: ${error}`);
                vscode.window.showErrorMessage(`Failed to switch TTS backend: ${error}`);
            }
        } else if (selected && selected.backend === currentBackend) {
            vscode.window.showInformationMessage(`Already using ${selected.label.replace('$(check) ', '')}`);
        }
    });

    // Register all commands
    context.subscriptions.push(
        switchToSileroCommand,
        switchToEspeakCommand,
        switchToOpenAICommand,
        showTTSStatusCommand,
        selectTTSBackendCommand
    );

    log('[TTS Backend Switch] Commands registered successfully');
} 