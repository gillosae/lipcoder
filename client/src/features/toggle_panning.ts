import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { config } from '../config';
import { setPanningEnabled, getTTSSettings } from '../tts';

export function registerTogglePanning(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.togglePanning', async () => {
            // Get current TTS settings
            const currentSettings = getTTSSettings();
            const newPanningState = !currentSettings.panningEnabled;
            
            // Update TTS settings
            setPanningEnabled(newPanningState);
            
            // Update VS Code configuration
            const vsCodeConfig = vscode.workspace.getConfiguration('lipcoder');
            await vsCodeConfig.update('tts.panningEnabled', newPanningState, vscode.ConfigurationTarget.Global);
            
            // Also update legacy config for compatibility
            config.globalPanningEnabled = newPanningState;
            
            const status = newPanningState ? 'enabled' : 'disabled';
            const message = `TTS spatial audio panning is now ${status}`;
            
            log(`[Toggle Panning] ${message}`);
            vscode.window.showInformationMessage(message);
        })
    );
} 