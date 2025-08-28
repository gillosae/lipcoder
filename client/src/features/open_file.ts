import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import { speakTokenList, speakGPT } from '../audio';
import { openFileTabAware } from './last_editor_tracker';

export function registerOpenFile(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openFile', async (...args: any[]) => {
            // Robustly extract filename from possible arguments
            let actualFilename = '';

            // 1) Prefer any direct string argument
            for (const arg of args) {
                if (typeof arg === 'string' && arg.trim()) {
                    actualFilename = arg.trim();
                    break;
                }
            }

            // 2) Try object with filename property
            if (!actualFilename) {
                for (const arg of args) {
                    if (arg && typeof arg === 'object' && typeof arg.filename === 'string' && arg.filename.trim()) {
                        actualFilename = arg.filename.trim();
                        break;
                    }
                }
            }

            // 3) As a last resort, use toString if it yields something meaningful
            if (!actualFilename) {
                for (const arg of args) {
                    if (arg && typeof arg === 'object' && typeof arg.toString === 'function') {
                        const s = String(arg.toString());
                        if (s && s !== '[object Object]') {
                            actualFilename = s.trim();
                            break;
                        }
                    }
                }
            }
            
            if (!actualFilename || actualFilename.trim() === '') {
                await speakGPT('No filename provided');
                return;
            }
            
            // Clean up the filename
            actualFilename = actualFilename.trim();

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                await speakGPT('No workspace folder open');
                return;
            }

            try {
                // Build a case-insensitive glob for the filename (so README.md matches readme.md, etc.)
                const toCaseInsensitiveGlob = (name: string) => name.split('').map(ch => {
                    if (/[a-zA-Z]/.test(ch)) {
                        return `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
                    }
                    return ch;
                }).join('');

                // Search for files matching the (case-insensitive) filename
                const searchPattern = `**/*${toCaseInsensitiveGlob(actualFilename)}*`;
                const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', 50);
                
                if (files.length === 0) {
                    await speakGPT(`File ${actualFilename} not found`);
                    return;
                }

                // Score and sort files by relevance
                const scoredFiles = files.map(file => {
                    const basename = path.basename(file.fsPath, path.extname(file.fsPath));
                    const fullBasename = path.basename(file.fsPath);
                    const relativePath = vscode.workspace.asRelativePath(file);
                    const lowerFilename = actualFilename.toLowerCase();
                    const lowerBasename = basename.toLowerCase();
                    const lowerFullBasename = fullBasename.toLowerCase();
                    
                    let score = 0;
                    
                    // Exact match (highest priority)
                    if (lowerBasename === lowerFilename || lowerFullBasename === lowerFilename) {
                        score += 1000;
                    }
                    // Check if filename ends with the search term (handles cases like "4_freeform.py" when searching "freeform.py")
                    else if (lowerFullBasename.endsWith(lowerFilename)) {
                        score += 900; // Very high priority for suffix matches
                    }
                    // Check if basename ends with the search term (without extension)
                    else if (lowerBasename.endsWith(lowerFilename.replace(/\.[^.]*$/, ''))) {
                        score += 850; // High priority for basename suffix matches
                    }
                    // Starts with filename
                    else if (lowerBasename.startsWith(lowerFilename) || lowerFullBasename.startsWith(lowerFilename)) {
                        score += 500;
                    }
                    // Contains filename
                    else if (lowerBasename.includes(lowerFilename) || lowerFullBasename.includes(lowerFilename)) {
                        score += 100;
                    }
                    
                    // Prefer files in root or common directories
                    const pathDepth = relativePath.split('/').length;
                    if (pathDepth === 1) {
                        score += 50; // Root level
                    } else if (pathDepth === 2) {
                        score += 25; // One level deep
                    }
                    
                    // Prefer common file types
                    const ext = path.extname(file.fsPath).toLowerCase();
                    if (['.ts', '.js', '.py', '.json', '.md'].includes(ext)) {
                        score += 10;
                    }
                    
                    // Prefer shorter paths (more specific)
                    score += Math.max(0, 20 - relativePath.length / 5);
                    
                    return { file, score, basename: fullBasename, relativePath };
                });

                // If user specified an exact filename with extension and we have exact matches,
                // directly open the best exact match (prefer shallowest path), skipping the picker.
                const lowerInput = actualFilename.toLowerCase();
                const inputHasExtension = path.extname(actualFilename).toLowerCase() !== '';
                let preselectedTarget: vscode.Uri | null = null;

                if (inputHasExtension) {
                    const exactFullMatches = scoredFiles.filter(item => item.basename.toLowerCase() === lowerInput);
                    if (exactFullMatches.length > 0) {
                        exactFullMatches.sort((a, b) => {
                            const depthA = a.relativePath.split('/').length;
                            const depthB = b.relativePath.split('/').length;
                            if (depthA !== depthB) return depthA - depthB; // prefer shallower
                            return a.relativePath.length - b.relativePath.length; // then shorter path
                        });
                        preselectedTarget = exactFullMatches[0].file;
                    }
                }

                // Sort by score (highest first)
                scoredFiles.sort((a, b) => b.score - a.score);

                let targetFile: vscode.Uri;

                // Prefer preselected exact match when available
                if (preselectedTarget) {
                    targetFile = preselectedTarget;
                }
                // If the top match has a significantly higher score than others, use it
                else if (scoredFiles.length === 1 || 
                    (scoredFiles[0].score >= 1000) || // Exact match
                    (scoredFiles[0].score > scoredFiles[1].score + 100)) { // Significantly better
                    targetFile = scoredFiles[0].file;
                } else {
                    // Show only the top 5 most relevant matches
                    const topMatches = scoredFiles.slice(0, 5);
                    const fileItems = topMatches.map(item => ({
                        label: item.basename,
                        description: item.relativePath,
                        uri: item.file
                    }));

                    // Announce that user should choose from list
                    await speakGPT('Choose from list');

                    // Create quick pick with audio feedback
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.items = fileItems;
                    quickPick.placeholder = `Multiple files found for "${actualFilename}". Select one:`;
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
                        await speakGPT('File selection cancelled');
                        return;
                    }

                    targetFile = selected.uri;
                }

                // Open the file using tab-aware logic
                const editor = await openFileTabAware(targetFile.fsPath);

                // Provide audio feedback
                const fileName = path.basename(targetFile.fsPath);
                if (editor) {
                    await speakGPT(`Opened ${fileName}`);
                } else {
                    await speakGPT(`Failed to open ${fileName}`);
                }

            } catch (error) {
                console.error('Error opening file:', error);
                await speakGPT(`Error opening file ${actualFilename}`);
            }
        })
    );
}
