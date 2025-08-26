import * as vscode from 'vscode';
import { log, logSuccess, logWarning } from '../utils';
import { ASRClient } from '../asr';
import { GPT4oASRClient } from '../gpt4o_asr';
import { currentASRBackend, ASRBackend } from '../config';

/**
 * ASR Speed Optimizer - Pre-warming and caching for faster ASR responses
 */

// Pre-warmed ASR clients pool
let prewarmedSileroClient: ASRClient | null = null;
let prewarmedGPT4oClient: GPT4oASRClient | null = null;

// Response cache for common patterns
const asrResponseCache = new Map<string, {
    response: string;
    timestamp: number;
    hitCount: number;
}>();

const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;

/**
 * Pre-warm ASR clients during extension startup for instant availability
 */
export async function prewarmASRClients(): Promise<void> {
    try {
        log('[ASR-Optimizer] Pre-warming ASR clients for instant startup...');
        
        // Pre-warm Silero client
        if (!prewarmedSileroClient) {
            prewarmedSileroClient = new ASRClient({
                onTranscription: () => {}, // Dummy handler for pre-warming
                onError: () => {},
                onASRReady: () => {
                    log('[ASR-Optimizer] Silero client pre-warmed and ready');
                }
            });
        }
        
        // Pre-warm GPT4o client  
        if (!prewarmedGPT4oClient) {
            prewarmedGPT4oClient = new GPT4oASRClient({
                onTranscription: () => {}, // Dummy handler for pre-warming
                onError: () => {},
                onRecordingStart: () => {},
                onRecordingStop: () => {}
            });
            log('[ASR-Optimizer] GPT4o client pre-warmed and ready');
        }
        
        logSuccess('[ASR-Optimizer] ASR clients pre-warmed successfully');
    } catch (error) {
        logWarning(`[ASR-Optimizer] Failed to pre-warm ASR clients: ${error}`);
    }
}

/**
 * Get pre-warmed ASR client for instant use
 */
export function getPrewarmedASRClient(): ASRClient | GPT4oASRClient | null {
    if (currentASRBackend === ASRBackend.GPT4o && prewarmedGPT4oClient) {
        return prewarmedGPT4oClient;
    } else if (currentASRBackend === ASRBackend.Silero && prewarmedSileroClient) {
        return prewarmedSileroClient;
    }
    return null;
}

/**
 * Cache ASR response for faster repeated queries
 */
export function cacheASRResponse(input: string, response: string): void {
    // Clean old entries if cache is full
    if (asrResponseCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = Array.from(asrResponseCache.keys())[0];
        asrResponseCache.delete(oldestKey);
    }
    
    const normalizedInput = input.toLowerCase().trim();
    asrResponseCache.set(normalizedInput, {
        response,
        timestamp: Date.now(),
        hitCount: 0
    });
    
    log(`[ASR-Optimizer] Cached response for: "${normalizedInput}"`);
}

/**
 * Get cached ASR response if available and not expired
 */
export function getCachedASRResponse(input: string): string | null {
    const normalizedInput = input.toLowerCase().trim();
    const cached = asrResponseCache.get(normalizedInput);
    
    if (!cached) {
        return null;
    }
    
    // Check if cache entry is expired
    if (Date.now() - cached.timestamp > CACHE_EXPIRY_MS) {
        asrResponseCache.delete(normalizedInput);
        return null;
    }
    
    // Update hit count and timestamp
    cached.hitCount++;
    cached.timestamp = Date.now();
    
    log(`[ASR-Optimizer] Cache hit for: "${normalizedInput}" (hits: ${cached.hitCount})`);
    return cached.response;
}

/**
 * Pre-cache common ASR patterns for instant responses
 */
export function precacheCommonPatterns(): void {
    const commonPatterns = [
        // Navigation commands
        { input: 'go to line', response: 'workbench.action.gotoLine' },
        { input: 'find file', response: 'workbench.action.quickOpen' },
        { input: 'close file', response: 'workbench.action.closeActiveEditor' },
        { input: 'save file', response: 'workbench.action.files.save' },
        { input: 'new file', response: 'workbench.action.files.newUntitledFile' },
        
        // Editing commands
        { input: 'copy line', response: 'editor.action.copyLinesDownAction' },
        { input: 'delete line', response: 'editor.action.deleteLines' },
        { input: 'comment line', response: 'editor.action.commentLine' },
        { input: 'format document', response: 'editor.action.formatDocument' },
        { input: 'select all', response: 'editor.action.selectAll' },
        
        // Search commands
        { input: 'find', response: 'actions.find' },
        { input: 'replace', response: 'editor.action.startFindReplaceAction' },
        { input: 'find in files', response: 'workbench.action.findInFiles' },
        
        // Terminal commands
        { input: 'open terminal', response: 'workbench.action.terminal.new' },
        { input: 'close terminal', response: 'workbench.action.terminal.kill' },
        
        // Panel commands
        { input: 'toggle sidebar', response: 'workbench.action.toggleSidebarVisibility' },
        { input: 'toggle panel', response: 'workbench.action.togglePanel' },
        { input: 'show explorer', response: 'workbench.view.explorer' },
        
        // Korean commands
        { input: '파일 열기', response: 'workbench.action.quickOpen' },
        { input: '파일 저장', response: 'workbench.action.files.save' },
        { input: '파일 닫기', response: 'workbench.action.closeActiveEditor' },
        { input: '줄 삭제', response: 'editor.action.deleteLines' },
        { input: '주석 토글', response: 'editor.action.commentLine' }
    ];
    
    for (const pattern of commonPatterns) {
        cacheASRResponse(pattern.input, pattern.response);
    }
    
    logSuccess(`[ASR-Optimizer] Pre-cached ${commonPatterns.length} common patterns`);
}

/**
 * Optimize ASR processing by reducing audio chunk size for faster processing
 */
export function optimizeASRProcessing(): {
    chunkDuration: number;
    sampleRate: number;
    bufferSize: number;
} {
    // Reduce chunk duration for faster processing
    const optimizedConfig = {
        chunkDuration: 500, // Reduce from default 1000ms to 500ms
        sampleRate: 16000,  // Keep standard sample rate
        bufferSize: 4096,   // Smaller buffer for lower latency
    };
    
    log('[ASR-Optimizer] Applied optimized ASR processing settings');
    return optimizedConfig;
}

/**
 * Clear expired cache entries
 */
export function cleanupExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, value] of asrResponseCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY_MS) {
            asrResponseCache.delete(key);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        log(`[ASR-Optimizer] Cleaned up ${cleanedCount} expired cache entries`);
    }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
    size: number;
    totalHits: number;
    mostUsed: string[];
} {
    const totalHits = Array.from(asrResponseCache.values())
        .reduce((sum, entry) => sum + entry.hitCount, 0);
    
    const mostUsed = Array.from(asrResponseCache.entries())
        .sort(([,a], [,b]) => b.hitCount - a.hitCount)
        .slice(0, 5)
        .map(([key]) => key);
    
    return {
        size: asrResponseCache.size,
        totalHits,
        mostUsed
    };
}

/**
 * Initialize ASR speed optimizations
 */
export function initializeASROptimizations(): void {
    log('[ASR-Optimizer] Initializing ASR speed optimizations...');
    
    // Pre-warm clients
    prewarmASRClients();
    
    // Pre-cache common patterns
    precacheCommonPatterns();
    
    // Set up periodic cache cleanup
    setInterval(cleanupExpiredCache, 60000); // Clean every minute
    
    logSuccess('[ASR-Optimizer] ASR speed optimizations initialized');
}

/**
 * Dispose ASR optimizer resources
 */
export function disposeASROptimizer(): void {
    if (prewarmedSileroClient) {
        prewarmedSileroClient.dispose();
        prewarmedSileroClient = null;
    }
    
    if (prewarmedGPT4oClient) {
        prewarmedGPT4oClient.dispose();
        prewarmedGPT4oClient = null;
    }
    
    asrResponseCache.clear();
    
    log('[ASR-Optimizer] ASR optimizer resources disposed');
}
