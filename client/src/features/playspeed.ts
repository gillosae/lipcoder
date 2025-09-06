import * as vscode from 'vscode';
import { config } from '../config';
import { log } from '../utils';

/**
 * Registers the command to adjust playback speed.
 * NOTE: Pitch preservation can be toggled with separate commands
 */
export function registerPlaySpeed(context: vscode.ExtensionContext) {
    // Enhanced set playspeed command with better UX
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeed', async () => {
            const pitchInfo = config.preservePitch ? 
                ' (pitch preserved using FFmpeg)' : 
                ' (pitch will change - enable pitch preservation to avoid chipmunk effect)';
            
            const input = await vscode.window.showInputBox({
                prompt: `Set LipCoder global playback speed multiplier${pitchInfo}`,
                placeHolder: 'e.g., 1.0 = normal, 1.5 = 50% faster, 0.8 = 20% slower',
                value: config.playSpeed.toString(),
                validateInput: (value) => {
                    const val = parseFloat(value);
                    if (isNaN(val) || val <= 0) {
                        return 'Please enter a positive number';
                    }
                    if (val > 3) {
                        return 'Maximum playspeed is 3.0x';
                    }
                    if (val < 0.1) {
                        return 'Minimum playspeed is 0.1x';
                    }
                    return null;
                }
            });
            if (input !== undefined) {
                const val = parseFloat(input);
                if (!isNaN(val) && val > 0) {
                    config.playSpeed = val;
                    const pitchNote = config.preservePitch ? 
                        '🎵 Pitch preserved!' : 
                        '⚠️ Pitch will change - use "Toggle Pitch Preservation" to maintain original pitch';
                    vscode.window.showInformationMessage(
                        `🎵 LipCoder playback speed set to ${val}× (affects all audio: earcons, TTS, special characters)\n${pitchNote}`
                    );
                } else {
                    vscode.window.showErrorMessage('Invalid playback speed. Enter a positive number.');
                }
            }
        })
    );

    // Toggle pitch preservation
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.togglePitchPreservation', () => {
            config.preservePitch = !config.preservePitch;
            const status = config.preservePitch ? 'enabled' : 'disabled';
            const icon = config.preservePitch ? '🎵' : '🎤';
            const note = config.preservePitch ? 
                'Uses FFmpeg time stretching - pitch stays constant when changing speed' :
                'Uses sample rate adjustment - pitch changes with speed (chipmunk effect)';
            vscode.window.showInformationMessage(
                `${icon} LipCoder pitch preservation ${status}\n${note}`
            );
        })
    );

    // New cache clearing command to fix crackling audio
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.clearAudioCache', async () => {
            try {
                const fs = require('fs');
                const path = require('path');
                const os = require('os');
                
                // Clear time-stretch cache
                const timeStretchCacheDir = path.join(os.tmpdir(), 'lipcoder_timestretch');
                if (fs.existsSync(timeStretchCacheDir)) {
                    const files = fs.readdirSync(timeStretchCacheDir);
                    let deletedCount = 0;
                    
                    for (const file of files) {
                        const filePath = path.join(timeStretchCacheDir, file);
                        if (fs.statSync(filePath).isFile()) {
                            fs.unlinkSync(filePath);
                            deletedCount++;
                        }
                    }
                    
                    vscode.window.showInformationMessage(
                        `LipCoder: Cleared ${deletedCount} cached audio files. Audio should sound cleaner now.`
                    );
                    log(`[ClearCache] Deleted ${deletedCount} time-stretched cache files`);
                } else {
                    vscode.window.showInformationMessage('LipCoder: Audio cache was already empty.');
                }
                
                // Clear TTS cache as well
                const ttsCacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
                if (fs.existsSync(ttsCacheDir)) {
                    const files = fs.readdirSync(ttsCacheDir);
                    let deletedCount = 0;
                    
                    for (const file of files) {
                        const filePath = path.join(ttsCacheDir, file);
                        if (fs.statSync(filePath).isFile()) {
                            fs.unlinkSync(filePath);
                            deletedCount++;
                        }
                    }
                    log(`[ClearCache] Deleted ${deletedCount} TTS cache files`);
                }
                
            } catch (error) {
                vscode.window.showErrorMessage(`LipCoder: Failed to clear audio cache: ${error}`);
                console.error('[ClearCache] Error:', error);
            }
        })
    );

    // Quick playspeed presets for convenience
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeedSlow', () => {
            config.playSpeed = 0.8;
            const pitchNote = config.preservePitch ? '(pitch preserved)' : '(lower pitch)';
            vscode.window.showInformationMessage(`🐢 LipCoder playback speed set to 0.8× ${pitchNote}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeedNormal', () => {
            config.playSpeed = 1.0;
            vscode.window.showInformationMessage('⏯️ LipCoder playback speed set to 1.0× (normal)');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeedFast', () => {
            config.playSpeed = 1.5;  
            const pitchNote = config.preservePitch ? '(pitch preserved)' : '(higher pitch)';
            vscode.window.showInformationMessage(`🐰 LipCoder playback speed set to 1.5× ${pitchNote}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeedVeryFast', () => {
            config.playSpeed = 2.0;
            const pitchNote = config.preservePitch ? '(pitch preserved)' : '(much higher pitch)';
            vscode.window.showInformationMessage(`🚀 LipCoder playback speed set to 2.0× ${pitchNote}`);
        })
    );

    // Add ultra-fast preset for power users
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeedUltraFast', () => {
            config.playSpeed = 3.0;
            const pitchNote = config.preservePitch ? '(pitch preserved)' : '(extremely high pitch)';
            vscode.window.showInformationMessage(`⚡ LipCoder playback speed set to 3.0× ${pitchNote}`);
        })
    );
}
