/**
 * Earcon Mode Toggle Feature
 * Allows users to switch between sound earcons and text-based earcons
 */

import * as vscode from 'vscode';
import { EarconMode, earconModeState } from '../config';
import { log, logSuccess } from '../utils';

// Helper function to get mode description
function getModeDescription(mode: EarconMode): string {
    switch (mode) {
        case EarconMode.Sound:
            return 'Sound Earcons (traditional audio cues for all characters)';
        case EarconMode.Text:
            return 'Text Earcons (spoken descriptions for all characters)';
        case EarconMode.ParenthesesOnly:
            return 'Parentheses Earcons (sounds for ( ) only, text for others)';
        default:
            return 'Unknown Mode';
    }
}

export function registerEarconModeCommands(context: vscode.ExtensionContext): void {
    // Command to toggle earcon mode (cycles through all three modes)
    const toggleEarconModeCommand = vscode.commands.registerCommand('lipcoder.toggleEarconMode', async () => {
        const currentMode = earconModeState.mode;
        let newMode: EarconMode;
        
        // Cycle through: ParenthesesOnly → Sound → Text → ParenthesesOnly
        switch (currentMode) {
            case EarconMode.ParenthesesOnly:
                newMode = EarconMode.Sound;
                break;
            case EarconMode.Sound:
                newMode = EarconMode.Text;
                break;
            case EarconMode.Text:
            default:
                newMode = EarconMode.ParenthesesOnly;
                break;
        }
        
        earconModeState.mode = newMode;
        
        const modeDescription = getModeDescription(newMode);
        
        logSuccess(`Earcon Mode: ${modeDescription}`);
        vscode.window.showInformationMessage(`✅ Earcon Mode: ${modeDescription}`);
        
        log(`[EarconMode] Switched from ${currentMode} to ${newMode}`);
    });

    // Command to set earcon mode to sound
    const setSoundModeCommand = vscode.commands.registerCommand('lipcoder.setEarconModeSound', async () => {
        earconModeState.mode = EarconMode.Sound;
        logSuccess('Earcon Mode: Sound Earcons (traditional audio cues)');
        vscode.window.showInformationMessage('✅ Earcon Mode: Sound Earcons');
        log('[EarconMode] Set to Sound mode');
    });

    // Command to set earcon mode to text
    const setTextModeCommand = vscode.commands.registerCommand('lipcoder.setEarconModeText', async () => {
        earconModeState.mode = EarconMode.Text;
        logSuccess('Earcon Mode: Text Earcons (spoken descriptions)');
        vscode.window.showInformationMessage('✅ Earcon Mode: Text Earcons');
        log('[EarconMode] Set to Text mode');
    });

    // Command to set earcon mode to parentheses only
    const setParenthesesOnlyModeCommand = vscode.commands.registerCommand('lipcoder.setEarconModeParenthesesOnly', async () => {
        earconModeState.mode = EarconMode.ParenthesesOnly;
        logSuccess('Earcon Mode: Parentheses Earcons (sounds for ( ) only, text for others)');
        vscode.window.showInformationMessage('✅ Earcon Mode: Parentheses Only');
        log('[EarconMode] Set to ParenthesesOnly mode');
    });

    // Command to show current earcon mode status
    const showEarconModeCommand = vscode.commands.registerCommand('lipcoder.showEarconMode', async () => {
        const currentMode = earconModeState.mode;
        const modeDescription = getModeDescription(currentMode);
        
        const statusMessage = `Current Earcon Mode: ${modeDescription}`;
        
        log(`[EarconMode] ${statusMessage}`);
        vscode.window.showInformationMessage(statusMessage);
    });

    // Command to select earcon mode from quick pick
    const selectEarconModeCommand = vscode.commands.registerCommand('lipcoder.selectEarconMode', async () => {
        const items = [
            {
                label: '🎯 Parentheses Earcons (Default)',
                description: 'Sounds for ( ) only, text for everything else',
                detail: 'Best of both worlds: quick parentheses sounds + clear text descriptions',
                mode: EarconMode.ParenthesesOnly
            },
            {
                label: '🔊 Sound Earcons',
                description: 'Traditional audio cues for all special characters',
                detail: 'Play distinctive sounds for brackets, operators, punctuation',
                mode: EarconMode.Sound
            },
            {
                label: '🗣️ Text Earcons',
                description: 'Spoken descriptions for all special characters',
                detail: 'Speak "left parenthesis", "equals", "comma", etc. instead of sounds',
                mode: EarconMode.Text
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Earcon Mode',
            title: 'Choose how special characters should be announced'
        });

        if (selected) {
            earconModeState.mode = selected.mode;
            const modeDescription = getModeDescription(selected.mode);
            
            logSuccess(`Earcon Mode: ${modeDescription}`);
            vscode.window.showInformationMessage(`✅ Earcon Mode: ${modeDescription}`);
            log(`[EarconMode] Selected: ${selected.mode}`);
        }
    });

    // Register all commands
    context.subscriptions.push(
        toggleEarconModeCommand,
        setSoundModeCommand,
        setTextModeCommand,
        setParenthesesOnlyModeCommand,
        showEarconModeCommand,
        selectEarconModeCommand
    );

    log('[EarconMode] Commands registered successfully');
}
