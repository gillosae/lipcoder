import * as vscode from 'vscode';
import { log } from '../utils';
import { debugTabTracking, getTabPosition, openFileInRememberedTab } from './tab_tracker';
import { debugEditorTracking, openFileTabAware } from './last_editor_tracker';
import { speakTokenList, speakGPT } from '../audio';

export function registerTestTabTracker(context: vscode.ExtensionContext) {
    // Command to debug tab tracking
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.debugTabTracking', async () => {
            debugTabTracking();
            debugEditorTracking();
            
            await speakGPT('Tab tracking debug info logged');
        })
    );

    // Command to test tab-aware file opening
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testTabAwareOpen', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                await speakGPT('No active editor to test with');
                return;
            }

            const filePath = activeEditor.document.uri.fsPath;
            const tabInfo = getTabPosition(filePath);
            
            if (tabInfo) {
                log(`[TestTabTracker] Current file tab info: group=${tabInfo.tabGroupIndex}, tab=${tabInfo.tabIndex}, column=${tabInfo.viewColumn}`);
                await speakTokenList([{ 
                    tokens: [`Current file is in tab group ${tabInfo.tabGroupIndex}, tab ${tabInfo.tabIndex}`], 
                    category: undefined 
                }]);
                
                // Test reopening the same file
                setTimeout(async () => {
                    log(`[TestTabTracker] Testing tab-aware reopening of ${filePath}`);
                    const editor = await openFileTabAware(filePath);
                    if (editor) {
                        await speakGPT('File reopened in remembered tab');
                    } else {
                        await speakGPT('Failed to reopen file');
                    }
                }, 1000);
            } else {
                await speakGPT('No tab info found for current file');
            }
        })
    );

    // Command to show tab groups info
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.showTabGroups', async () => {
            const tabGroups = vscode.window.tabGroups;
            log(`[TestTabTracker] Current tab groups: ${tabGroups.all.length}`);
            
            let message = `${tabGroups.all.length} tab groups: `;
            tabGroups.all.forEach((group, idx) => {
                message += `Group ${idx} has ${group.tabs.length} tabs, `;
            });
            
            await speakGPT(message);
            
            // Log detailed info
            tabGroups.all.forEach((group, idx) => {
                log(`[TestTabTracker] Group ${idx} (column ${group.viewColumn}): ${group.tabs.length} tabs`);
                group.tabs.forEach((tab, tabIdx) => {
                    if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input) {
                        const uri = (tab.input as any).uri;
                        log(`[TestTabTracker]   Tab ${tabIdx}: ${uri?.fsPath || 'unknown'}`);
                    }
                });
            });
        })
    );
}
