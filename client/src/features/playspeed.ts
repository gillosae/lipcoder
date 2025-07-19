import * as vscode from 'vscode';
import { config } from '../config';

/**
 * Registers the command to adjust playback speed.
 */
export function registerPlaySpeed(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.setPlaySpeed', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Set LipCoder playback speed multiplier (e.g., 1.0 = normal, 1.5 = 50% faster)',
                value: config.playSpeed.toString()
            });
            if (input !== undefined) {
                const val = parseFloat(input);
                if (!isNaN(val) && val > 0) {
                    config.playSpeed = val;
                    vscode.window.showInformationMessage(`LipCoder playback speed set to ${val}×`);
                } else {
                    vscode.window.showErrorMessage('Invalid playback speed. Enter a positive number.');
                }
            }
        })
    );
}
