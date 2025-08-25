import * as vscode from 'vscode';
import { log, logSuccess, logWarning } from '../utils';

/**
 * Tab Tracker
 * Tracks file positions in tab groups and enables reopening files in their original tabs
 * instead of creating new tabs in different panels
 */

interface TabInfo {
    filePath: string;
    tabGroupIndex: number;
    tabIndex: number;
    lastAccessTime: Date;
    viewColumn: vscode.ViewColumn;
}

// Map of file paths to their tab information
let tabPositions: Map<string, TabInfo> = new Map();

/**
 * Update tab position information for a file
 */
function updateTabPosition(editor: vscode.TextEditor): void {
    if (!editor || !editor.document) {
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const viewColumn = editor.viewColumn || vscode.ViewColumn.One;
    
    try {
        // Find the tab group and tab index
        const tabGroups = vscode.window.tabGroups;
        let tabGroupIndex = -1;
        let tabIndex = -1;

        // Search through all tab groups to find this editor
        for (let groupIdx = 0; groupIdx < tabGroups.all.length; groupIdx++) {
            const group = tabGroups.all[groupIdx];
            for (let tabIdx = 0; tabIdx < group.tabs.length; tabIdx++) {
                const tab = group.tabs[tabIdx];
                if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input && 
                    (tab.input as any).uri?.fsPath === filePath) {
                    tabGroupIndex = groupIdx;
                    tabIndex = tabIdx;
                    break;
                }
            }
            if (tabGroupIndex !== -1) break;
        }

        const tabInfo: TabInfo = {
            filePath,
            tabGroupIndex,
            tabIndex,
            lastAccessTime: new Date(),
            viewColumn
        };

        tabPositions.set(filePath, tabInfo);
        log(`[TabTracker] Updated tab position for ${filePath}: group=${tabGroupIndex}, tab=${tabIndex}, column=${viewColumn}`);
    } catch (error) {
        logWarning(`[TabTracker] Failed to update tab position for ${filePath}: ${error}`);
    }
}

/**
 * Get remembered tab position for a file
 */
export function getTabPosition(filePath: string): TabInfo | undefined {
    return tabPositions.get(filePath);
}

/**
 * Open a file in its remembered tab position, or create a new tab if no position is remembered
 */
export async function openFileInRememberedTab(filePath: string): Promise<vscode.TextEditor | undefined> {
    try {
        const uri = vscode.Uri.file(filePath);
        const tabInfo = tabPositions.get(filePath);

        if (tabInfo) {
            log(`[TabTracker] Attempting to reopen ${filePath} in remembered position: group=${tabInfo.tabGroupIndex}, tab=${tabInfo.tabIndex}`);
            
            // Try to find if the file is already open in any tab
            const tabGroups = vscode.window.tabGroups;
            for (const group of tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input && 
                        (tab.input as any).uri?.fsPath === filePath) {
                        // File is already open, just focus it
                        log(`[TabTracker] File already open, focusing existing tab`);
                        await vscode.window.showTextDocument(uri, {
                            viewColumn: group.viewColumn,
                            preserveFocus: false
                        });
                        return vscode.window.activeTextEditor;
                    }
                }
            }

            // File is not currently open, try to open it in the remembered position
            try {
                // Check if the remembered tab group still exists
                if (tabInfo.tabGroupIndex < tabGroups.all.length) {
                    const targetGroup = tabGroups.all[tabInfo.tabGroupIndex];
                    
                    // Open the document in the remembered view column
                    const editor = await vscode.window.showTextDocument(uri, {
                        viewColumn: targetGroup.viewColumn,
                        preserveFocus: false
                    });
                    
                    log(`[TabTracker] Successfully reopened ${filePath} in remembered tab group`);
                    return editor;
                } else {
                    // Remembered tab group no longer exists, use the remembered view column
                    log(`[TabTracker] Remembered tab group no longer exists, using view column ${tabInfo.viewColumn}`);
                    const editor = await vscode.window.showTextDocument(uri, {
                        viewColumn: tabInfo.viewColumn,
                        preserveFocus: false
                    });
                    return editor;
                }
            } catch (error) {
                logWarning(`[TabTracker] Failed to open in remembered position, falling back to default: ${error}`);
            }
        }

        // No remembered position or fallback needed - open normally
        log(`[TabTracker] No remembered position for ${filePath}, opening normally`);
        const editor = await vscode.window.showTextDocument(uri);
        return editor;

    } catch (error) {
        logWarning(`[TabTracker] Failed to open file ${filePath}: ${error}`);
        return undefined;
    }
}

/**
 * Clear tab position memory for a file (when file is closed)
 */
export function clearTabPosition(filePath: string): void {
    if (tabPositions.delete(filePath)) {
        log(`[TabTracker] Cleared tab position for ${filePath}`);
    }
}

/**
 * Get all tracked tab positions (for debugging)
 */
export function getAllTabPositions(): Map<string, TabInfo> {
    return new Map(tabPositions);
}

/**
 * Initialize tab tracking
 */
export function initializeTabTracking(context: vscode.ExtensionContext): void {
    log('[TabTracker] Initializing tab tracking...');

    // Track active editor changes
    const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            updateTabPosition(editor);
        }
    });

    // Track tab changes
    const onDidChangeTabGroups = vscode.window.tabGroups.onDidChangeTabs((event) => {
        // Update positions for opened tabs
        event.opened.forEach(tab => {
            if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input) {
                const filePath = (tab.input as any).uri?.fsPath;
                if (filePath) {
                    // Find the editor for this tab
                    const editor = vscode.window.visibleTextEditors.find(e => 
                        e.document.uri.fsPath === filePath
                    );
                    if (editor) {
                        updateTabPosition(editor);
                    }
                }
            }
        });

        // Clear positions for closed tabs
        event.closed.forEach(tab => {
            if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input) {
                const filePath = (tab.input as any).uri?.fsPath;
                if (filePath) {
                    clearTabPosition(filePath);
                }
            }
        });
    });

    // Track document opening
    const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument((document) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document === document) {
            updateTabPosition(activeEditor);
        }
    });

    // Initialize with current active editor
    const currentActive = vscode.window.activeTextEditor;
    if (currentActive) {
        updateTabPosition(currentActive);
    }

    // Register event listeners
    context.subscriptions.push(
        onDidChangeActiveTextEditor,
        onDidChangeTabGroups,
        onDidOpenTextDocument
    );

    logSuccess('[TabTracker] Tab tracking initialized');
}

/**
 * Cleanup tab tracking
 */
export function cleanupTabTracking(): void {
    tabPositions.clear();
    log('[TabTracker] Tab tracking cleaned up');
}

/**
 * Debug information
 */
export function debugTabTracking(): void {
    log('[TabTracker] === DEBUG INFO ===');
    log(`Tracked tab positions: ${tabPositions.size}`);
    
    tabPositions.forEach((info, filePath) => {
        log(`  ${filePath}:`);
        log(`    Group: ${info.tabGroupIndex}, Tab: ${info.tabIndex}, Column: ${info.viewColumn}`);
        log(`    Last access: ${info.lastAccessTime.toLocaleTimeString()}`);
    });
    
    // Current tab groups info
    const tabGroups = vscode.window.tabGroups;
    log(`Current tab groups: ${tabGroups.all.length}`);
    tabGroups.all.forEach((group, idx) => {
        log(`  Group ${idx} (column ${group.viewColumn}): ${group.tabs.length} tabs`);
    });
    
    log('[TabTracker] === END DEBUG ===');
}
