import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, speakGPT } from '../audio';

export function registerOpenPng(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openPngFile', async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                await speakGPT('No workspace folder open');
                return;
            }

            try {
                // Search for PNG files in the workspace
                const files = await vscode.workspace.findFiles('**/*.png', '**/node_modules/**', 50);
                
                if (files.length === 0) {
                    await speakGPT('No PNG files found in workspace');
                    return;
                }

                // Score and sort PNG files by relevance (prefer recently modified, shorter paths)
                const scoredFiles = await Promise.all(files.map(async (file) => {
                    const relativePath = vscode.workspace.asRelativePath(file);
                    const basename = path.basename(file.fsPath);
                    
                    let score = 0;
                    
                    // Get file stats for modification time
                    try {
                        const stats = await vscode.workspace.fs.stat(file);
                        const now = Date.now();
                        const ageInHours = (now - stats.mtime) / (1000 * 60 * 60);
                        
                        // Prefer recently modified files (within last 24 hours gets bonus)
                        if (ageInHours < 24) {
                            score += 1000 - ageInHours; // More recent = higher score
                        } else {
                            score += Math.max(0, 100 - ageInHours / 24); // Gradual decrease
                        }
                    } catch (error) {
                        // If we can't get stats, give a neutral score
                        score += 50;
                    }
                    
                    // Prefer files in root or common directories
                    const pathDepth = relativePath.split('/').length;
                    if (pathDepth === 1) {
                        score += 100; // Root level
                    } else if (pathDepth === 2) {
                        score += 50; // One level deep
                    }
                    
                    // Prefer shorter paths (more accessible)
                    score += Math.max(0, 50 - relativePath.length / 5);
                    
                    // Bonus for common generated image names
                    const lowerBasename = basename.toLowerCase();
                    if (lowerBasename.includes('generated') || 
                        lowerBasename.includes('output') || 
                        lowerBasename.includes('result') ||
                        lowerBasename.includes('chart') ||
                        lowerBasename.includes('graph') ||
                        lowerBasename.includes('plot')) {
                        score += 200;
                    }
                    
                    return { file, score, basename, relativePath };
                }));

                // Sort by score (highest first)
                scoredFiles.sort((a, b) => b.score - a.score);

                let targetFile: vscode.Uri;

                if (scoredFiles.length === 1) {
                    // Only one PNG file, open it directly
                    targetFile = scoredFiles[0].file;
                } else if (scoredFiles[0].score > scoredFiles[1].score + 100) {
                    // Top file has significantly higher score, open it directly
                    targetFile = scoredFiles[0].file;
                } else {
                    // Show picker for multiple relevant files
                    const topMatches = scoredFiles.slice(0, 10); // Show top 10 matches
                    const fileItems = topMatches.map(item => ({
                        label: item.basename,
                        description: item.relativePath,
                        uri: item.file
                    }));

                    // Announce that user should choose from list
                    await speakGPT('Choose PNG file from list');

                    // Create quick pick with audio feedback
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.items = fileItems;
                    quickPick.placeholder = `Multiple PNG files found. Select one:`;
                    quickPick.matchOnDescription = true;

                    // Track current selection for audio feedback
                    let currentIndex = -1;

                    // Handle selection changes with audio feedback
                    quickPick.onDidChangeActive(async (activeItems) => {
                        if (activeItems.length > 0) {
                            const newIndex = quickPick.items.indexOf(activeItems[0]);
                            if (newIndex !== currentIndex) {
                                currentIndex = newIndex;
                                const item = activeItems[0];
                                // Read the filename when navigating
                                await speakTokenList([{ tokens: [item.label], category: undefined }]);
                            }
                        }
                    });

                    // Show the quick pick
                    quickPick.show();

                    // Announce the first item after a short delay
                    setTimeout(async () => {
                        if (quickPick.items.length > 0) {
                            const firstItem = quickPick.items[0];
                            currentIndex = 0;
                            await speakTokenList([{ tokens: [firstItem.label], category: undefined }]);
                        }
                    }, 300);

                    // Wait for selection
                    const selected = await new Promise<typeof fileItems[0] | undefined>((resolve) => {
                        quickPick.onDidAccept(() => {
                            const activeItem = quickPick.activeItems[0];
                            if (activeItem) {
                                // Find the original item with uri
                                const originalItem = fileItems.find(item => 
                                    item.label === activeItem.label && 
                                    item.description === activeItem.description
                                );
                                quickPick.hide();
                                resolve(originalItem);
                            } else {
                                quickPick.hide();
                                resolve(undefined);
                            }
                        });

                        quickPick.onDidHide(() => {
                            resolve(undefined);
                        });
                    });

                    if (!selected) {
                        await speakGPT('PNG file selection cancelled');
                        return;
                    }

                    targetFile = selected.uri;
                }

                // Open the PNG file using VS Code's default image viewer
                await vscode.commands.executeCommand('vscode.open', targetFile);

                // Provide audio feedback
                const fileName = path.basename(targetFile.fsPath);
                await speakGPT(`Opened ${fileName}`);

            } catch (error) {
                console.error('Error opening PNG file:', error);
                await speakGPT('Error opening PNG file');
            }
        })
    );
}
