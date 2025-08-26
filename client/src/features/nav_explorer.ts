import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { stopReading } from './stop_reading';
import { speakTokenList, TokenChunk, playWave } from '../audio';
import { parseFilename, log } from '../utils';
import { config } from '../config';

// Fast explorer state tracking (like editor code reading)
let currentExplorerItem: vscode.Uri | null = null;
let explorerReady = false;
let explorerAbortController: AbortController | null = null;

// Simple directory cache for immediate lookups
const directoryCache = new Map<string, boolean>();

/**
 * Fast directory check - synchronous like editor code reading
 */
function isDirectorySync(filePath: string): boolean {
    // Check cache first
    if (directoryCache.has(filePath)) {
        return directoryCache.get(filePath)!;
    }
    
    try {
        const stat = fs.statSync(filePath); // Synchronous like editor reading
        const isDir = stat.isDirectory();
        
        // Cache with size limit
        if (directoryCache.size > 50) {
            const firstKey = directoryCache.keys().next().value;
            if (firstKey !== undefined) {
                directoryCache.delete(firstKey);
            }
        }
        directoryCache.set(filePath, isDir);
        
        return isDir;
    } catch {
        directoryCache.set(filePath, false);
        return false;
    }
}

/**
 * Fast file reading like editor - immediate audio without delays
 */
function readExplorerItemFast(filePath: string): void {
    // Process file info synchronously (like editor)
    const name = path.basename(filePath);
    const isDir = isDirectorySync(filePath);
    const depth = calculateFileDepthFast(filePath);
    
    // Prepare tokens with file/folder prefix
    const nameTokens = isDir ? [name] : parseFilename(name);
    const typePrefix = isDir ? "folder" : "file";
    const tokens = [typePrefix, ...nameTokens];
    // Don't set category - let individual tokens use their natural mapping (alphabet PCM, earcons, etc.)
    const category = undefined;
    
    // IMMEDIATE: Aggressive stop of all audio and cancel previous navigation
    stopReading();
    if (explorerAbortController) {
        explorerAbortController.abort();
    }
    explorerAbortController = new AbortController();
    
    // Play audio immediately - ZERO delays for maximum speed
    if (depth > 0) {
        // Play indent and content simultaneously - no delays at all
        playIndentationSound(depth).catch(() => {});
        speakTokenList([{ tokens, category }], explorerAbortController?.signal).catch(() => {});
    } else {
        // Root level - immediate playback
        speakTokenList([{ tokens, category }], explorerAbortController?.signal).catch(() => {});
    }
}

/**
 * Fast depth calculation - synchronous like editor
 */
function calculateFileDepthFast(filePath: string): number {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return 0;
    }
    
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const relativePath = path.relative(workspaceRoot, filePath);
    
    if (relativePath === '' || relativePath === '.') {
        return 0;
    }
    
    const parts = relativePath.split(path.sep).filter(part => part !== '' && part !== '.');
    return Math.max(0, parts.length - 1);
}

/**
 * Play indentation sound based on depth level - optimized for speed
 */
async function playIndentationSound(depth: number): Promise<void> {
    if (depth === 0) {
        return; // No indentation sound for root level
    }
    
    // Clamp depth to available indent files (0-9)
    const clampedDepth = Math.min(depth, 9);
    const indentFile = `indent_${clampedDepth}.pcm`;
    
    try {
        const indentPath = path.join(config.earconPath(), indentFile);
        // Skip existence check for speed - let playWave handle errors
        await playWave(indentPath, { isEarcon: true, immediate: true });
    } catch (error) {
        // Silently fail for speed
    }
}

export function registerNavExplorer(context: vscode.ExtensionContext) {
    // Set up ready state like editor code reading
    setTimeout(() => { explorerReady = true; }, 1000);
    
    context.subscriptions.push(
        // FAST APPROACH: Like editor code reading - immediate, synchronous processing
        vscode.commands.registerCommand('lipcoder.explorerUp', async () => {
            if (!explorerReady) return;
            
            try {
                // Execute VS Code command and get path immediately
                await vscode.commands.executeCommand('list.focusUp');
                await vscode.commands.executeCommand('copyFilePath');
                const filePath = await vscode.env.clipboard.readText();
                
                // FAST: Process immediately like editor code reading
                readExplorerItemFast(filePath);
                
            } catch (error) {
                log(`[explorerUp] Error: ${error}`);
            }
        }),
        
        vscode.commands.registerCommand('lipcoder.explorerDown', async () => {
            if (!explorerReady) return;
            
            try {
                // Execute VS Code command and get path immediately
                await vscode.commands.executeCommand('list.focusDown');
                await vscode.commands.executeCommand('copyFilePath');
                const filePath = await vscode.env.clipboard.readText();
                
                // FAST: Process immediately like editor code reading
                readExplorerItemFast(filePath);
                
            } catch (error) {
                log(`[explorerDown] Error: ${error}`);
            }
        })
    );
}

/**
 * Stop any ongoing explorer navigation and audio
 */
export function stopExplorerNavigation(): void {
    stopReading();
    if (explorerAbortController) {
        explorerAbortController.abort();
        explorerAbortController = null;
    }
    currentExplorerItem = null;
}

/**
 * Clear the directory cache (useful for testing or when file system changes)
 */
export function clearDirectoryCache(): void {
    directoryCache.clear();
    log('[nav_explorer] Directory cache cleared');
}
