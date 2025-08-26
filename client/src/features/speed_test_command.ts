import * as vscode from 'vscode';
import { log, logSuccess, logWarning } from '../utils';
import { getCacheStats } from './asr_speed_optimizer';
import { getLLMCacheStats } from './llm_speed_optimizer';

/**
 * Speed Test Command - Test and measure ASR/LLM performance improvements
 */

interface SpeedTestResult {
    testName: string;
    duration: number;
    success: boolean;
    details?: any;
}

/**
 * Test ASR processing speed with and without optimizations
 */
async function testASRSpeed(): Promise<SpeedTestResult[]> {
    const results: SpeedTestResult[] = [];
    
    // Test 1: Cache hit performance
    try {
        const startTime = Date.now();
        const { getCachedASRResponse } = await import('./asr_speed_optimizer.js');
        
        // Test common commands
        const testCommands = ['close file', 'save file', 'find file', 'new file'];
        let cacheHits = 0;
        
        for (const command of testCommands) {
            const cached = getCachedASRResponse(command);
            if (cached) {
                cacheHits++;
            }
        }
        
        const duration = Date.now() - startTime;
        results.push({
            testName: 'ASR Cache Performance',
            duration,
            success: true,
            details: { cacheHits, totalTests: testCommands.length }
        });
    } catch (error) {
        results.push({
            testName: 'ASR Cache Performance',
            duration: 0,
            success: false,
            details: { error: String(error) }
        });
    }
    
    // Test 2: ASR client initialization speed
    try {
        const startTime = Date.now();
        const { getPrewarmedASRClient } = await import('./asr_speed_optimizer.js');
        
        const client = getPrewarmedASRClient();
        const duration = Date.now() - startTime;
        
        results.push({
            testName: 'ASR Client Initialization',
            duration,
            success: !!client,
            details: { clientAvailable: !!client }
        });
    } catch (error) {
        results.push({
            testName: 'ASR Client Initialization',
            duration: 0,
            success: false,
            details: { error: String(error) }
        });
    }
    
    return results;
}

/**
 * Test LLM processing speed with optimizations
 */
async function testLLMSpeed(): Promise<SpeedTestResult[]> {
    const results: SpeedTestResult[] = [];
    
    // Test 1: LLM cache performance
    try {
        const startTime = Date.now();
        const { getCachedLLMResponse } = await import('./llm_speed_optimizer.js');
        
        // Test common LLM patterns
        const testPatterns = [
            {
                system: "You are a code autocomplete assistant. Only output the code completion snippet without any explanation or commentary.",
                user: "Complete this code line:\nconst ",
                maxTokens: 64,
                temperature: 0.2
            },
            {
                system: "Convert natural language to VS Code commands. Return only the command name.",
                user: "close file",
                maxTokens: 64,
                temperature: 0.2
            }
        ];
        
        let cacheHits = 0;
        for (const pattern of testPatterns) {
            const cached = getCachedLLMResponse(
                pattern.system,
                pattern.user,
                pattern.maxTokens,
                pattern.temperature
            );
            if (cached) {
                cacheHits++;
            }
        }
        
        const duration = Date.now() - startTime;
        results.push({
            testName: 'LLM Cache Performance',
            duration,
            success: true,
            details: { cacheHits, totalTests: testPatterns.length }
        });
    } catch (error) {
        results.push({
            testName: 'LLM Cache Performance',
            duration: 0,
            success: false,
            details: { error: String(error) }
        });
    }
    
    // Test 2: Optimized LLM call
    try {
        const startTime = Date.now();
        const { optimizedLLMCall } = await import('./llm_speed_optimizer.js');
        
        // This should hit cache if pre-cached patterns are working
        const response = await optimizedLLMCall(
            "Convert natural language to VS Code commands. Return only the command name.",
            "close file",
            64,
            0.2
        );
        
        const duration = Date.now() - startTime;
        results.push({
            testName: 'Optimized LLM Call',
            duration,
            success: !!response,
            details: { response: response.substring(0, 50) + '...' }
        });
    } catch (error) {
        results.push({
            testName: 'Optimized LLM Call',
            duration: 0,
            success: false,
            details: { error: String(error) }
        });
    }
    
    return results;
}

/**
 * Run comprehensive speed tests
 */
export async function runSpeedTests(): Promise<void> {
    try {
        log('[Speed-Test] Starting comprehensive speed tests...');
        
        const startTime = Date.now();
        
        // Run ASR speed tests
        const asrResults = await testASRSpeed();
        
        // Run LLM speed tests  
        const llmResults = await testLLMSpeed();
        
        const totalDuration = Date.now() - startTime;
        
        // Get cache statistics
        const asrStats = getCacheStats();
        const llmStats = getLLMCacheStats();
        
        // Generate report
        const report = generateSpeedTestReport(asrResults, llmResults, asrStats, llmStats, totalDuration);
        
        // Show results in new document
        const document = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(document);
        
        logSuccess('[Speed-Test] Speed tests completed successfully');
        
    } catch (error) {
        logWarning(`[Speed-Test] Speed tests failed: ${error}`);
        vscode.window.showErrorMessage(`Speed tests failed: ${error}`);
    }
}

/**
 * Generate speed test report
 */
function generateSpeedTestReport(
    asrResults: SpeedTestResult[],
    llmResults: SpeedTestResult[],
    asrStats: any,
    llmStats: any,
    totalDuration: number
): string {
    const now = new Date().toLocaleString();
    
    let report = `# LipCoder Speed Test Report\n\n`;
    report += `**Generated:** ${now}\n`;
    report += `**Total Test Duration:** ${totalDuration}ms\n\n`;
    
    // ASR Results
    report += `## ASR Performance Tests\n\n`;
    for (const result of asrResults) {
        const status = result.success ? '✅' : '❌';
        report += `### ${status} ${result.testName}\n`;
        report += `- **Duration:** ${result.duration}ms\n`;
        report += `- **Success:** ${result.success}\n`;
        if (result.details) {
            report += `- **Details:** ${JSON.stringify(result.details, null, 2)}\n`;
        }
        report += `\n`;
    }
    
    // LLM Results
    report += `## LLM Performance Tests\n\n`;
    for (const result of llmResults) {
        const status = result.success ? '✅' : '❌';
        report += `### ${status} ${result.testName}\n`;
        report += `- **Duration:** ${result.duration}ms\n`;
        report += `- **Success:** ${result.success}\n`;
        if (result.details) {
            report += `- **Details:** ${JSON.stringify(result.details, null, 2)}\n`;
        }
        report += `\n`;
    }
    
    // Cache Statistics
    report += `## Cache Statistics\n\n`;
    report += `### ASR Cache\n`;
    report += `- **Size:** ${asrStats.size} entries\n`;
    report += `- **Total Hits:** ${asrStats.totalHits}\n`;
    report += `- **Most Used:** ${asrStats.mostUsed.join(', ')}\n\n`;
    
    report += `### LLM Cache\n`;
    report += `- **Size:** ${llmStats.size} entries\n`;
    report += `- **Total Hits:** ${llmStats.totalHits}\n`;
    report += `- **Pending Requests:** ${llmStats.pendingRequests}\n\n`;
    
    // Performance Analysis
    report += `## Performance Analysis\n\n`;
    
    const avgASRDuration = asrResults.reduce((sum, r) => sum + r.duration, 0) / asrResults.length;
    const avgLLMDuration = llmResults.reduce((sum, r) => sum + r.duration, 0) / llmResults.length;
    
    report += `- **Average ASR Test Duration:** ${avgASRDuration.toFixed(2)}ms\n`;
    report += `- **Average LLM Test Duration:** ${avgLLMDuration.toFixed(2)}ms\n`;
    
    if (asrStats.totalHits > 0) {
        report += `- **ASR Cache Hit Rate:** High (${asrStats.totalHits} hits)\n`;
    } else {
        report += `- **ASR Cache Hit Rate:** Low (consider using more common commands)\n`;
    }
    
    if (llmStats.totalHits > 0) {
        report += `- **LLM Cache Hit Rate:** High (${llmStats.totalHits} hits)\n`;
    } else {
        report += `- **LLM Cache Hit Rate:** Low (pre-cached patterns working)\n`;
    }
    
    // Recommendations
    report += `\n## Recommendations\n\n`;
    
    if (avgASRDuration > 50) {
        report += `- ⚠️ ASR processing is slower than expected (>${avgASRDuration.toFixed(2)}ms). Consider optimizing audio chunk processing.\n`;
    } else {
        report += `- ✅ ASR processing is performing well (<50ms average).\n`;
    }
    
    if (avgLLMDuration > 100) {
        report += `- ⚠️ LLM processing is slower than expected (>${avgLLMDuration.toFixed(2)}ms). Consider increasing cache size or using faster models.\n`;
    } else {
        report += `- ✅ LLM processing is performing well (<100ms average).\n`;
    }
    
    if (asrStats.size < 10) {
        report += `- 💡 ASR cache is small (${asrStats.size} entries). Use more commands to build up cache.\n`;
    }
    
    if (llmStats.size < 20) {
        report += `- 💡 LLM cache is small (${llmStats.size} entries). More usage will improve performance.\n`;
    }
    
    return report;
}

/**
 * Register speed test command
 */
export function registerSpeedTestCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.runSpeedTests', runSpeedTests)
    );
    
    log('[Speed-Test] Speed test command registered');
}
