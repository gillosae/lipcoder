import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { config } from '../config';

export function registerTogglePanning(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.togglePanning', () => {
            config.globalPanningEnabled = !config.globalPanningEnabled;
            const status = config.globalPanningEnabled ? 'enabled' : 'disabled';
            const message = `Global audio panning is now ${status}`;
            
            log(`[Toggle Panning] ${message}`);
            vscode.window.showInformationMessage(message);
        })
    );
} 