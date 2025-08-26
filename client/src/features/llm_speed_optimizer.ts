import * as vscode from 'vscode';
import { log, logSuccess, logWarning } from '../utils';
import { callLLMForCompletion } from '../llm';

/**
 * LLM Speed Optimizer - Caching and batching for faster LLM responses
 */

// LLM response cache
const llmResponseCache = new Map<string, {
    response: string;
    timestamp: number;
    hitCount: number;
}>();

// Pending LLM requests for batching
const pendingRequests = new Map<string, {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timestamp: number;
}>();

const CACHE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes for LLM cache
const MAX_CACHE_SIZE = 200;
const BATCH_DELAY_MS = 100; // Wait 100ms to batch similar requests

/**
 * Generate cache key for LLM request
 */
function generateCacheKey(systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number): string {
    const key = `${systemPrompt}|${userPrompt}|${maxTokens}|${temperature}`;
    return Buffer.from(key).toString('base64').substring(0, 64); // Truncate for reasonable key size
}

/**
 * Cache LLM response
 */
export function cacheLLMResponse(
    systemPrompt: string, 
    userPrompt: string, 
    maxTokens: number, 
    temperature: number, 
    response: string
): void {
    // Clean old entries if cache is full
    if (llmResponseCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = Array.from(llmResponseCache.keys())[0];
        llmResponseCache.delete(oldestKey);
    }
    
    const cacheKey = generateCacheKey(systemPrompt, userPrompt, maxTokens, temperature);
    llmResponseCache.set(cacheKey, {
        response,
        timestamp: Date.now(),
        hitCount: 0
    });
    
    log(`[LLM-Optimizer] Cached LLM response (key: ${cacheKey.substring(0, 16)}...)`);
}

/**
 * Get cached LLM response if available and not expired
 */
export function getCachedLLMResponse(
    systemPrompt: string, 
    userPrompt: string, 
    maxTokens: number, 
    temperature: number
): string | null {
    const cacheKey = generateCacheKey(systemPrompt, userPrompt, maxTokens, temperature);
    const cached = llmResponseCache.get(cacheKey);
    
    if (!cached) {
        return null;
    }
    
    // Check if cache entry is expired
    if (Date.now() - cached.timestamp > CACHE_EXPIRY_MS) {
        llmResponseCache.delete(cacheKey);
        return null;
    }
    
    // Update hit count and timestamp
    cached.hitCount++;
    cached.timestamp = Date.now();
    
    log(`[LLM-Optimizer] LLM cache hit (key: ${cacheKey.substring(0, 16)}..., hits: ${cached.hitCount})`);
    return cached.response;
}

/**
 * Optimized LLM call with caching and batching
 */
export async function optimizedLLMCall(
    systemPrompt: string, 
    userPrompt: string, 
    maxTokens: number = 64, 
    temperature: number = 0.2
): Promise<string> {
    // Check cache first
    const cachedResponse = getCachedLLMResponse(systemPrompt, userPrompt, maxTokens, temperature);
    if (cachedResponse) {
        return cachedResponse;
    }
    
    const cacheKey = generateCacheKey(systemPrompt, userPrompt, maxTokens, temperature);
    
    // Check if there's already a pending request for the same query
    const existingRequest = pendingRequests.get(cacheKey);
    if (existingRequest) {
        log(`[LLM-Optimizer] Batching duplicate LLM request`);
        return new Promise((resolve, reject) => {
            // Replace the existing handlers to handle multiple waiters
            const originalResolve = existingRequest.resolve;
            const originalReject = existingRequest.reject;
            
            existingRequest.resolve = (value: string) => {
                originalResolve(value);
                resolve(value);
            };
            
            existingRequest.reject = (error: Error) => {
                originalReject(error);
                reject(error);
            };
        });
    }
    
    // Create new request promise
    return new Promise((resolve, reject) => {
        pendingRequests.set(cacheKey, {
            resolve,
            reject,
            timestamp: Date.now()
        });
        
        // Batch requests with a small delay
        setTimeout(async () => {
            const request = pendingRequests.get(cacheKey);
            if (!request) return;
            
            pendingRequests.delete(cacheKey);
            
            try {
                log(`[LLM-Optimizer] Executing LLM request (batched)`);
                const response = await callLLMForCompletion(systemPrompt, userPrompt, maxTokens, temperature);
                
                // Cache the response
                cacheLLMResponse(systemPrompt, userPrompt, maxTokens, temperature, response);
                
                request.resolve(response);
            } catch (error) {
                request.reject(error as Error);
            }
        }, BATCH_DELAY_MS);
    });
}

/**
 * Pre-cache common LLM patterns for instant responses
 */
export function precacheLLMPatterns(): void {
    const commonPatterns = [
        // Code completion patterns
        {
            system: "You are a code autocomplete assistant. Only output the code completion snippet without any explanation or commentary.",
            user: "Complete this code line:\nconst ",
            response: "variableName = "
        },
        {
            system: "You are a code autocomplete assistant. Only output the code completion snippet without any explanation or commentary.",
            user: "Complete this code line:\nfunction ",
            response: "functionName() {\n    \n}"
        },
        {
            system: "You are a code autocomplete assistant. Only output the code completion snippet without any explanation or commentary.",
            user: "Complete this code line:\nif (",
            response: "condition) {\n    \n}"
        },
        
        // Command interpretation patterns
        {
            system: "Convert natural language to VS Code commands. Return only the command name.",
            user: "close file",
            response: "workbench.action.closeActiveEditor"
        },
        {
            system: "Convert natural language to VS Code commands. Return only the command name.",
            user: "save file",
            response: "workbench.action.files.save"
        },
        {
            system: "Convert natural language to VS Code commands. Return only the command name.",
            user: "find file",
            response: "workbench.action.quickOpen"
        }
    ];
    
    for (const pattern of commonPatterns) {
        cacheLLMResponse(pattern.system, pattern.user, 64, 0.2, pattern.response);
    }
    
    logSuccess(`[LLM-Optimizer] Pre-cached ${commonPatterns.length} common LLM patterns`);
}

/**
 * Clean up expired LLM cache entries
 */
export function cleanupExpiredLLMCache(): void {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, value] of llmResponseCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY_MS) {
            llmResponseCache.delete(key);
            cleanedCount++;
        }
    }
    
    // Clean up stale pending requests
    for (const [key, request] of pendingRequests.entries()) {
        if (now - request.timestamp > 30000) { // 30 seconds timeout
            pendingRequests.delete(key);
            request.reject(new Error('LLM request timeout'));
        }
    }
    
    if (cleanedCount > 0) {
        log(`[LLM-Optimizer] Cleaned up ${cleanedCount} expired LLM cache entries`);
    }
}

/**
 * Get LLM cache statistics
 */
export function getLLMCacheStats(): {
    size: number;
    totalHits: number;
    pendingRequests: number;
} {
    const totalHits = Array.from(llmResponseCache.values())
        .reduce((sum, entry) => sum + entry.hitCount, 0);
    
    return {
        size: llmResponseCache.size,
        totalHits,
        pendingRequests: pendingRequests.size
    };
}

/**
 * Parallel LLM processing for multiple requests
 */
export async function parallelLLMCalls(requests: Array<{
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
    temperature?: number;
}>): Promise<string[]> {
    log(`[LLM-Optimizer] Processing ${requests.length} LLM requests in parallel`);
    
    const promises = requests.map(req => 
        optimizedLLMCall(
            req.systemPrompt, 
            req.userPrompt, 
            req.maxTokens || 64, 
            req.temperature || 0.2
        )
    );
    
    return Promise.all(promises);
}

/**
 * Initialize LLM speed optimizations
 */
export function initializeLLMOptimizations(): void {
    log('[LLM-Optimizer] Initializing LLM speed optimizations...');
    
    // Pre-cache common patterns
    precacheLLMPatterns();
    
    // Set up periodic cache cleanup
    setInterval(cleanupExpiredLLMCache, 2 * 60 * 1000); // Clean every 2 minutes
    
    logSuccess('[LLM-Optimizer] LLM speed optimizations initialized');
}

/**
 * Dispose LLM optimizer resources
 */
export function disposeLLMOptimizer(): void {
    llmResponseCache.clear();
    
    // Reject all pending requests
    for (const [key, request] of pendingRequests.entries()) {
        request.reject(new Error('Extension is shutting down'));
    }
    pendingRequests.clear();
    
    log('[LLM-Optimizer] LLM optimizer resources disposed');
}
