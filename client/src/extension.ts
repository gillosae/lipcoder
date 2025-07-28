import * as vscode from 'vscode';
import { setBackend, TTSBackend } from './config';
import { createAudioMap } from './mapping';
import { preloadEverything } from './preload';
import { config, initConfig } from './config';
import { installDependencies } from './install_dependencies';
import { log, logWarning, logSuccess, logError, logMemory } from './utils';

import { registerEchoTest } from './features/echo_test';
import { registerWhereAmI } from './features/where_am_i';
import { registerReadLineTokens } from './features/read_line_tokens';
import { loadDictionaryWord } from './features/word_logic';
import { registerStopReading } from './features/stop_reading';
import { registerToggleTypingSpeech } from './features/toggle_typing_speech';
import { startLanguageClient } from './language_client';
import { registerReadCurrentLine } from './features/current_line';
import { registerReadFunctionTokens } from './features/read_function_tokens';
import { registerBreadcrumb } from './features/breadcrumb';
import { registerSymbolTree } from './features/symbol_tree';
import { registerSwitchPanel } from './features/switch_panel';
import { registerFunctionList } from './features/function_list';
import { registerFileTree } from './features/file_tree';
import { registerTerminalReader } from './features/terminal';
import { registerFormatCode } from './features/format_code';
import { registerNavExplorer } from './features/nav_explorer';
import { registerNavEditor } from './features/nav_editor';
import { registerPlaySpeed } from './features/playspeed';

import { registerChatCompletions } from './llm';
import { registerSetAPIKey } from './features/set_api_key';
import { registerVibeCodingCommands } from './features/vibe_coding';
import { registerToggleASR } from './features/toggle_asr';
import { registerPushToTalkASR } from './features/push_to_talk_asr';
import { registerTogglePanning } from './features/toggle_panning';

// Memory monitoring
let memoryMonitorInterval: NodeJS.Timeout | null = null;

function startMemoryMonitoring(): void {
    if (memoryMonitorInterval) return;
    
    let lastMemoryUsage = process.memoryUsage();
    let logCounter = 0;
    
    memoryMonitorInterval = setInterval(() => {
        const currentMemory = process.memoryUsage();
        const heapUsedDelta = currentMemory.heapUsed - lastMemoryUsage.heapUsed;
        const rssUsedDelta = currentMemory.rss - lastMemoryUsage.rss;
        
        // Log every 10 intervals (roughly every 5 minutes) or if significant growth
        if (logCounter % 10 === 0 || heapUsedDelta > 10 * 1024 * 1024) { // 10MB growth
            logMemory(`[Memory] Heap: ${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)}MB (+${(heapUsedDelta / 1024 / 1024).toFixed(2)}MB), RSS: ${(currentMemory.rss / 1024 / 1024).toFixed(2)}MB (+${(rssUsedDelta / 1024 / 1024).toFixed(2)}MB)`);
        }
        
        lastMemoryUsage = currentMemory;
        logCounter++;
    }, 30000); // Check every 30 seconds
    
    logMemory('[Memory] Memory monitoring started');
}

function stopMemoryMonitoring(): void {
    if (memoryMonitorInterval) {
        clearInterval(memoryMonitorInterval);
        memoryMonitorInterval = null;
        logMemory('[Memory] Memory monitoring stopped');
    }
}

export async function activate(context: vscode.ExtensionContext) {
	// 0) Dependency installation in parallel ──────────────────────────────────────────────
	log('Extension Host running on Electron v' + process.versions.electron);
	installDependencies().catch(err => console.error('installDependencies failed:', err));

	// Start memory monitoring
	startMemoryMonitoring();

	// 1) Provide the extension root to config ───────────────────────────────────────────
	initConfig(context);

	// 2) TTS setup ───────────────────────────────────────────────────────────────────────
	await loadDictionaryWord();
	setBackend(TTSBackend.Silero);

	// 3) Pre-generate earcons into cache ────────────────────────────
	preloadEverything(context);

	// 4) Build the unified audioMap ─────────────────────────────────────────────
	const audioMap = createAudioMap(context);

	// 5) Start LanguageClient ──────────────────────────────────────────────────
	const client = startLanguageClient(context);

	// 6) Register commands ───────────────────────────────────────────────────────
	registerEchoTest(context, client);
	registerWhereAmI(context, client);
	registerBreadcrumb(context, client);
	registerReadLineTokens(context, client);
	registerPlaySpeed(context);
	registerReadFunctionTokens(context, client);
	registerStopReading(context);
	registerToggleTypingSpeech(context, client);
	registerReadCurrentLine(context);
	registerSymbolTree(context);
	registerSwitchPanel(context);
	registerFunctionList(context);
	registerFileTree(context);
	registerTerminalReader(context);
	registerFormatCode(context);
	registerNavExplorer(context);
	registerNavEditor(context, audioMap);
	registerSetAPIKey(context);
	registerChatCompletions(context);
	registerVibeCodingCommands(context);
	registerToggleASR(context);
	registerPushToTalkASR(context);
	registerTogglePanning(context);

}

export async function deactivate() {
	logWarning("🔄 lipcoder deactivate starting...");
	
	// Stop memory monitoring first
	stopMemoryMonitoring();
	
	// Force stop all audio immediately
	try {
		const { stopPlayback, cleanupAudioResources } = require('./audio');
		stopPlayback();
		logSuccess('✅ Audio playback stopped');
	} catch (err) {
		logError(`❌ Failed to stop audio playback: ${err}`);
	}
	
	// Stop language client with timeout
	try {
		const { stopLanguageClient } = require('./language_client');
		await Promise.race([
			stopLanguageClient(),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Language client stop timeout')), 3000))
		]);
		logSuccess('✅ Language client stopped');
	} catch (err) {
		logError(`❌ Failed to stop language client: ${err}`);
	}
	
	// Clean up all ASRClient instances aggressively
	const asrCleanupPromises = [];
	
	try {
		const { getASRClient: getStreamingClient } = require('./features/asr_streaming');
		const streamingClient = getStreamingClient();
		if (streamingClient) {
			if (streamingClient.getRecordingStatus()) {
				streamingClient.stopStreaming();
			}
			streamingClient.dispose();
			logSuccess('✅ Streaming ASR cleaned up');
		}
	} catch (err) {
		logError(`❌ Failed to cleanup streaming ASR: ${err}`);
	}
	
	try {
		const { getASRClient: getToggleClient } = require('./features/toggle_asr');
		const toggleClient = getToggleClient();
		if (toggleClient) {
			if (toggleClient.getRecordingStatus()) {
				toggleClient.stopStreaming();
			}
			toggleClient.dispose();
			logSuccess('✅ Toggle ASR cleaned up');
		}
	} catch (err) {
		logError(`❌ Failed to cleanup toggle ASR: ${err}`);
	}
	
	try {
		const { getASRClient: getPushToTalkClient } = require('./features/push_to_talk_asr');
		const pushToTalkClient = getPushToTalkClient();
		if (pushToTalkClient) {
			if (pushToTalkClient.getRecordingStatus()) {
				pushToTalkClient.stopStreaming();
			}
			pushToTalkClient.dispose();
			logSuccess('✅ Push-to-talk ASR cleaned up');
		}
	} catch (err) {
		logError(`❌ Failed to cleanup push-to-talk ASR: ${err}`);
	}
	
	// Clean up LLM resources
	try {
		const { cleanupLLMResources } = require('./llm');
		cleanupLLMResources();
		logSuccess('✅ LLM resources cleaned up');
	} catch (err) {
		logError(`❌ Failed to cleanup LLM resources: ${err}`);
	}
	
	// Final audio cleanup
	try {
		const { cleanupAudioResources } = require('./audio');
		cleanupAudioResources();
		logSuccess('✅ Audio resources cleaned up');
	} catch (err) {
		logError(`❌ Failed to cleanup audio resources: ${err}`);
	}
	
	// Clear any remaining intervals/timeouts
	try {
		// Force clear all known timers (less aggressive approach)
		// Note: This is a best-effort cleanup as we can't iterate all timers safely
		logWarning('🧹 Clearing known active timers...');
	} catch (err) {
		logError(`❌ Failed to clear timers: ${err}`);
	}
	
	// Force garbage collection if available
	if (global.gc) {
		try {
			global.gc();
			logSuccess('🗑️ Forced garbage collection');
		} catch (err) {
			logError(`❌ Failed to force GC: ${err}`);
		}
	}
	
	// Final memory report
	const finalMemory = process.memoryUsage();
	logMemory(`[Memory] Final: Heap: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB, RSS: ${(finalMemory.rss / 1024 / 1024).toFixed(2)}MB`);
	
	logSuccess("✅ lipcoder deactivation complete");
	
	// Give a moment for cleanup to complete
	await new Promise(resolve => setTimeout(resolve, 500));
}