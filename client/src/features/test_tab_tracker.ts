import * as vscode from 'vscode';
import { log } from '../utils';
import { debugTabTracking, getTabPosition, openFileInRememberedTab } from './tab_tracker';
import { debugEditorTracking, openFileTabAware } from './last_editor_tracker';
import { speakTokenList } from '../audio';

export function registerTestTabTracker(context: vscode.ExtensionContext) {
    // Command to debug tab tracking
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.debugTabTracking', async () => {
            debugTabTracking();
            debugEditorTracking();
            
            await speakTokenList([{ tokens: ['Tab tracking debug info logged'], category: undefined }]);
        })
    );

    // Command to test tab-aware file opening
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testTabAwareOpen', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                await speakTokenList([{ tokens: ['No active editor to test with'], category: undefined }]);
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
                        await speakTokenList([{ tokens: ['File reopened in remembered tab'], category: undefined }]);
                    } else {
                        await speakTokenList([{ tokens: ['Failed to reopen file'], category: undefined }]);
                    }
                }, 1000);
            } else {
                await speakTokenList([{ tokens: ['No tab info found for current file'], category: undefined }]);
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
            
            await speakTokenList([{ tokens: [message], category: undefined }]);
            
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
