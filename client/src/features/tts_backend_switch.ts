import * as vscode from 'vscode';
import { setBackend, TTSBackend, currentBackend, sileroConfig, espeakConfig, openaiTTSConfig, xttsV2Config } from '../config';
import { log, logSuccess, logWarning } from '../utils';
import { serverManager } from '../server_manager';

export function registerTTSBackendSwitch(context: vscode.ExtensionContext) {
    
    // Command to switch to Silero+GPT TTS (Silero for English, GPT for Korean)
    const switchToSileroGPTCommand = vscode.commands.registerCommand('lipcoder.switchToSileroGPT', async () => {
        try {
            log('[TTS Backend] Switching to Silero+GPT TTS...');
            
            // Start both Silero and ensure OpenAI is configured
            await serverManager.switchTTSBackend('silero');
            
            // Update the config to combined backend
            setBackend(TTSBackend.SileroGPT);
            
            log('[TTS Backend] Successfully switched to Silero+GPT TTS');
            vscode.window.showInformationMessage('✅ TTS Backend: Silero (English) + GPT (Korean)');
            logSuccess(`TTS Backend: Silero+GPT (Silero: ${sileroConfig.modelId}, GPT: ${openaiTTSConfig.voice})`);
        } catch (error) {
            logWarning(`Failed to switch to Silero+GPT TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to switch to Silero+GPT TTS: ${error}`);
        }
    });

    // Command to switch to Espeak+GPT TTS (Espeak for English, GPT for Korean)
    const switchToEspeakGPTCommand = vscode.commands.registerCommand('lipcoder.switchToEspeakGPT', async () => {
        try {
            log('[TTS Backend] Switching to Espeak+GPT TTS...');
            
            // Start Espeak server
            await serverManager.switchTTSBackend('espeak');
            
            // Update the config to combined backend
            setBackend(TTSBackend.EspeakGPT);
            
            log('[TTS Backend] Successfully switched to Espeak+GPT TTS');
            vscode.window.showInformationMessage('✅ TTS Backend: Espeak (English) + GPT (Korean)');
            logSuccess(`TTS Backend: Espeak+GPT (Espeak: ${espeakConfig.defaultVoice}, GPT: ${openaiTTSConfig.voice})`);
        } catch (error) {
            logWarning(`Failed to switch to Espeak+GPT TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to switch to Espeak+GPT TTS: ${error}`);
        }
    });

    // Command to switch to XTTS-v2 TTS (for both Korean and English)
    const switchToXTTSV2Command = vscode.commands.registerCommand('lipcoder.switchToXTTSV2', async () => {
        try {
            log('[TTS Backend] Switching to XTTS-v2 TTS...');
            
            // Start XTTS-v2 server
            await serverManager.switchTTSBackend('xtts-v2');
            
            // Update the config to XTTS-v2 backend
            setBackend(TTSBackend.XTTSV2);
            
            log('[TTS Backend] Successfully switched to XTTS-v2 TTS');
            vscode.window.showInformationMessage('✅ TTS Backend: XTTS-v2 (Korean + English)');
            logSuccess(`TTS Backend: XTTS-v2 (model: ${xttsV2Config.model}, supports both Korean and English)`);
        } catch (error) {
            logWarning(`Failed to switch to XTTS-v2 TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to switch to XTTS-v2 TTS: ${error}`);
        }
    });

    // Command to ensure MMS-TTS server is running (but don't change main backend)
    const ensureMMSTTSCommand = vscode.commands.registerCommand('lipcoder.ensureMMSTTS', async () => {
        try {
            log('[MMS-TTS] Ensuring MMS-TTS server is running for Korean text...');
            
            // Just start MMS-TTS server, don't change main backend
            await serverManager.startIndividualServer('mms_tts');
            
            // Don't change currentBackend - keep it for English text
            
            log('[MMS-TTS] MMS-TTS server is now running for Korean text');
            vscode.window.showInformationMessage('✅ MMS-TTS server started for Korean text - English backend unchanged');
            logSuccess(`XTTS-v2: Server running for Korean text (model: ${xttsV2Config.model}). English text uses ${currentBackend}.`);
        } catch (error) {
            logWarning(`Failed to start MMS-TTS server: ${error}`);
            vscode.window.showErrorMessage(`Failed to start MMS-TTS server: ${error}`);
        }
    });

    // Command to restart Korean TTS server (if needed)
    const restartKoreanTTSCommand = vscode.commands.registerCommand('lipcoder.restartKoreanTTS', async () => {
        try {
            log('[Korean TTS] Restarting MMS-TTS server...');
            
            // Stop and restart MMS-TTS server
            await serverManager.stopIndividualServer('mms_tts');
            await serverManager.startIndividualServer('mms_tts');
            
            log('[Korean TTS] Successfully restarted MMS-TTS server');
            vscode.window.showInformationMessage('🇰🇷 Korean TTS server restarted (MMS-TTS)');
            logSuccess(`Korean TTS: XTTS-v2 server restarted (model: ${xttsV2Config.model})`);
        } catch (error) {
            logWarning(`Failed to restart Korean TTS: ${error}`);
            vscode.window.showErrorMessage(`Failed to restart Korean TTS: ${error}`);
        }
    });

    // Command to show Korean TTS status
    const showKoreanTTSStatusCommand = vscode.commands.registerCommand('lipcoder.showKoreanTTSStatus', async () => {
        try {
            const serverStatus = serverManager.getServerStatus();
            const mmsTTSRunning = serverStatus['mms_tts']?.running || false;
            const mmsTTSPort = serverStatus['mms_tts']?.port || 'N/A';
            
            const statusMessage = `Korean TTS Status:
• MMS-TTS Server: ${mmsTTSRunning ? 'Running' : 'Stopped'}
• Port: ${mmsTTSPort}
• Model: ${xttsV2Config.model}
• Behavior: Korean text uses ${mmsTTSRunning ? 'MMS-TTS (fast)' : 'GPT TTS (fallback)'}
• English TTS: ${currentBackend} (unchanged)`;
            
            log(`[Korean TTS Status] ${statusMessage.replace(/\n/g, ', ')}`);
            vscode.window.showInformationMessage(statusMessage);
        } catch (error) {
            logWarning(`Failed to get Korean TTS status: ${error}`);
            vscode.window.showErrorMessage(`Failed to get Korean TTS status: ${error}`);
        }
    });

    // Command to show current TTS backend status
    const showTTSStatusCommand = vscode.commands.registerCommand('lipcoder.showTTSStatus', async () => {
        let statusMessage: string;
        
        // Get server status to show if servers are running
        const serverStatus = serverManager.getServerStatus();
        const sileroRunning = serverStatus['tts']?.running || false;
        const espeakRunning = serverStatus['espeak_tts']?.running || false;
        const xttsV2Running = serverStatus['xtts_v2']?.running || false;
        
        if (currentBackend === TTSBackend.SileroGPT) {
            statusMessage = `Current TTS Backend: Silero + GPT
• Silero (English): ${sileroRunning ? 'Running' : 'Stopped'} - Model: ${sileroConfig.modelId}, Speaker: ${sileroConfig.defaultSpeaker}
• GPT (Korean): API-based - Voice: ${openaiTTSConfig.voice}, Speed: ${openaiTTSConfig.speed}x
• Port: ${serverStatus['tts']?.port || 'N/A'}`;
        } else if (currentBackend === TTSBackend.EspeakGPT) {
            statusMessage = `Current TTS Backend: Espeak + GPT
• Espeak (English): ${espeakRunning ? 'Running' : 'Stopped'} - Voice: ${espeakConfig.defaultVoice}, Speed: ${espeakConfig.speed} WPM
• GPT (Korean): API-based - Voice: ${openaiTTSConfig.voice}, Speed: ${openaiTTSConfig.speed}x
• Port: ${serverStatus['espeak_tts']?.port || 'N/A'}`;
        } else if (currentBackend === TTSBackend.XTTSV2) {
            statusMessage = `Current TTS Backend: XTTS-v2 (Universal)
• XTTS-v2 (Korean + English): ${xttsV2Running ? 'Running' : 'Stopped'}
• Model: ${xttsV2Config.model}
• Sample Rate: ${xttsV2Config.sampleRate}Hz
• Port: ${serverStatus['xtts_v2']?.port || 'N/A'}`;
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
        const xttsV2Running = serverStatus['xtts_v2']?.running || false;
        
        const items = [
            {
                label: '🔄 Silero + GPT',
                description: `Silero (English) + GPT (Korean) ${sileroRunning ? '- Silero Running' : '- Silero Stopped'}`,
                detail: 'Neural TTS for English, Premium GPT TTS for Korean - Best balance of quality and speed',
                backend: TTSBackend.SileroGPT
            },
            {
                label: '⚡ Espeak + GPT',  
                description: `Espeak (English) + GPT (Korean) ${espeakRunning ? '- Espeak Running' : '- Espeak Stopped'}`,
                detail: 'Fast system TTS for English, Premium GPT TTS for Korean - Fastest option',
                backend: TTSBackend.EspeakGPT
            },
            {
                label: '🎯 XTTS-v2 (Universal)',
                description: `XTTS-v2 for both Korean and English ${xttsV2Running ? '- Running' : '- Stopped'}`,
                detail: 'High-quality neural TTS with voice cloning support for both languages',
                backend: TTSBackend.XTTSV2
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

        if (selected && selected.backend && selected.backend !== currentBackend) {
            try {
                log(`[TTS Backend] User selected: ${selected.backend}`);
                
                if (selected.backend === TTSBackend.SileroGPT) {
                    await vscode.commands.executeCommand('lipcoder.switchToSileroGPT');
                } else if (selected.backend === TTSBackend.EspeakGPT) {
                    await vscode.commands.executeCommand('lipcoder.switchToEspeakGPT');
                } else if (selected.backend === TTSBackend.XTTSV2) {
                    await vscode.commands.executeCommand('lipcoder.switchToXTTSV2');
                }
                
            } catch (error) {
                logWarning(`Failed to switch TTS backend: ${error}`);
                vscode.window.showErrorMessage(`Failed to switch TTS backend: ${error}`);
            }
        } else if (selected && selected.backend === currentBackend) {
            vscode.window.showInformationMessage(`Already using ${selected.label.replace('$(check) ', '')}`);
        } else if (selected && !selected.backend) {
            // User selected the Korean TTS note - show Korean TTS status
            await vscode.commands.executeCommand('lipcoder.showKoreanTTSStatus');
        }
    });

    // Register all commands
    context.subscriptions.push(
        switchToSileroGPTCommand,
        switchToEspeakGPTCommand,
        switchToXTTSV2Command,
        showTTSStatusCommand,
        selectTTSBackendCommand
    );

    log('[TTS Backend Switch] Commands registered successfully');
} 