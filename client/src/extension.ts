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
import { startLanguageClient, restartLanguageClient, getLanguageClient } from './language_client';
import { registerCurrentLine } from './features/current_line';
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
import { registerCodeAnalysis } from './features/code_analysis';
// import { registerToggleASR } from './features/toggle_asr';
// import { registerPushToTalkASR } from './features/push_to_talk_asr';
import { registerEnhancedPushToTalkASR } from './features/enhanced_push_to_talk_asr';
import { registerTogglePanning } from './features/toggle_panning';
import { registerTTSBackendSwitch } from './features/tts_backend_switch';
import { registerLLMBackendSwitch } from './features/llm_backend_switch';
import { registerOpenFile } from './features/open_file';
import { registerSyntaxErrors } from './features/syntax_errors';
import { serverManager } from './server_manager';

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
        
        // Log more frequently and at lower thresholds to catch memory issues
        if (logCounter % 5 === 0 || heapUsedDelta > 5 * 1024 * 1024) { // Every 2.5 minutes or 5MB growth
            logMemory(`[Memory] Heap: ${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)}MB (+${(heapUsedDelta / 1024 / 1024).toFixed(2)}MB), RSS: ${(currentMemory.rss / 1024 / 1024).toFixed(2)}MB (+${(rssUsedDelta / 1024 / 1024).toFixed(2)}MB)`);
        }
        
        // Trigger aggressive cleanup if memory usage is too high
        if (currentMemory.heapUsed > 80 * 1024 * 1024) { // 80MB heap threshold
            logWarning(`[Memory] High memory usage detected (${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)}MB), triggering cleanup`);
            try {
                const { cleanupAudioResources } = require('./audio');
                const { getLineTokenReadingActive } = require('./features/stop_reading');
                
                // Don't interrupt line token reading for memory cleanup
                if (getLineTokenReadingActive()) {
                    logWarning(`[Memory] Skipping cleanup during line token reading to avoid interruption`);
                } else {
                    cleanupAudioResources();
                }
            } catch (err) {
                logError(`Failed to cleanup during high memory usage: ${err}`);
            }
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
    // Store context for global cleanup
    (global as any).lipcoderContext = context;
    
	// 0) Dependency installation in parallel ──────────────────────────────────────────────
	log('Extension Host running on Electron v' + process.versions.electron);
	installDependencies().catch(err => console.error('installDependencies failed:', err));

	// Start memory monitoring
	startMemoryMonitoring();

	// 1) Provide the extension root to config ───────────────────────────────────────────
	initConfig(context);
	
	// 1.2) Load configuration from VS Code settings ─────────────────────────────────────
	const { loadConfigFromSettings } = require('./config');
	loadConfigFromSettings();

	// 1.5) Clean old corrupted cache files on startup ───────────────────────────────────
	try {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		
		const timeStretchCacheDir = path.join(os.tmpdir(), 'lipcoder_timestretch');
		if (fs.existsSync(timeStretchCacheDir)) {
			const files = fs.readdirSync(timeStretchCacheDir);
			const now = Date.now();
			let cleanedCount = 0;
			
			// Remove cache files older than 24 hours
			for (const file of files) {
				const filePath = path.join(timeStretchCacheDir, file);
				if (fs.statSync(filePath).isFile()) {
					const ageMs = now - fs.statSync(filePath).mtime.getTime();
					const ageHours = ageMs / (1000 * 60 * 60);
					
					if (ageHours > 24) {
						fs.unlinkSync(filePath);
						cleanedCount++;
					}
				}
			}
			
			if (cleanedCount > 0) {
				log(`[Startup] Cleaned ${cleanedCount} old cache files (>24h)`);
			}
		}
	} catch (error) {
		logWarning(`[Startup] Cache cleanup failed: ${error}`);
	}

	// 2) Start TTS and ASR servers ──────────────────────────────────────────────────────
	try {
		await serverManager.startServers();
		logSuccess('✅ All servers started successfully');
	} catch (error) {
		logError(`❌ Failed to start servers: ${error}`);
		vscode.window.showErrorMessage(`Failed to start lipcoder servers: ${error}`);
		// Continue anyway - some features may still work without servers
	}

	// 3) TTS setup ───────────────────────────────────────────────────────────────────────
	await loadDictionaryWord();
	setBackend(TTSBackend.Silero);

	// 3) Pre-generate earcons into cache ────────────────────────────
	preloadEverything(context);

	// 4) Build the unified audioMap ─────────────────────────────────────────────
	console.log('[EXTENSION] About to create audioMap...');
	const audioMap = createAudioMap(context);
	console.log('[EXTENSION] AudioMap created, underscore path:', audioMap['_']);

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
	registerCurrentLine(context);
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
	registerCodeAnalysis(context);
	// registerToggleASR(context);  // Disabled in favor of enhanced version
	// registerPushToTalkASR(context);  // Disabled in favor of enhanced version
	registerEnhancedPushToTalkASR(context);
	registerTogglePanning(context);
	registerTTSBackendSwitch(context);
	registerLLMBackendSwitch(context);
	registerOpenFile(context);
	registerSyntaxErrors(context);

	// Add command to restart language server
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.restartLanguageServer', async () => {
			try {
				vscode.window.showInformationMessage('Restarting LipCoder Language Server...');
				const newClient = await restartLanguageClient(context);
				if (newClient) {
					vscode.window.showInformationMessage('LipCoder Language Server restarted successfully! Tokenization changes are now active.');
				} else {
					vscode.window.showErrorMessage('Failed to restart LipCoder Language Server. Check the output for details.');
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Error restarting language server: ${error}`);
			}
		})
	);

	// Add command to test thinking audio
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.testThinkingAudio', async () => {
			try {
				const { testThinkingAudio } = await import('./audio.js');
				await testThinkingAudio();
				vscode.window.showInformationMessage('Thinking audio test completed!');
			} catch (error) {
				vscode.window.showErrorMessage(`Thinking audio test failed: ${error}`);
			}
		})
	);

	// Add command to test comment voice
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.testCommentVoice', async () => {
			try {
				const { speakTokenList } = await import('./audio.js');
				const { getSpeakerForCategory } = await import('./tts.js');
				const { currentBackend } = await import('./config.js');
				
				// Log current backend and voice mappings
				console.log(`[CommentVoiceTest] Current TTS backend: ${currentBackend}`);
				console.log(`[CommentVoiceTest] Variable voice: ${getSpeakerForCategory('variable')}`);
				console.log(`[CommentVoiceTest] Comment voice: ${getSpeakerForCategory('comment_text')}`);
				console.log(`[CommentVoiceTest] Comment symbol voice: ${getSpeakerForCategory('comment_symbol')}`);
				
				await speakTokenList([
					{ tokens: ['Variable token'], category: 'variable' },
					{ tokens: ['Comment text'], category: 'comment_text' },
					{ tokens: ['#'], category: 'comment_symbol' }
				]);
				vscode.window.showInformationMessage('Comment voice test completed! Check console for voice mappings.');
			} catch (error) {
				vscode.window.showErrorMessage(`Comment voice test failed: ${error}`);
			}
		})
	);

	// Add command to test comment line tokenization
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.testCommentTokenization', async () => {
			try {
				const client = (await import('./language_client.js')).getLanguageClient();
				if (!client) {
					vscode.window.showErrorMessage('Language server not available');
					return;
				}

				// Test tokenization of a comment line
				const testUri = 'file:///test.py';
				const testLine = 0;
				
				// Request tokens from server
				const tokens = await client.sendRequest('lipcoder/readLineTokens', {
					uri: testUri,
					line: testLine
				}) as Array<{ text: string; category: string }>;
				
				console.log(`[CommentTokenizationTest] Tokens for "# This is a comment":`, tokens);
				
				// Test with the actual tokens from server
				const { speakTokenList } = await import('./audio.js');
				const chunks = tokens.map(token => ({
					tokens: [token.text],
					category: token.category
				}));
				
				await speakTokenList(chunks);
				vscode.window.showInformationMessage(`Comment tokenization test completed! Found ${tokens.length} tokens. Check console.`);
			} catch (error) {
				vscode.window.showErrorMessage(`Comment tokenization test failed: ${error}`);
			}
		})
	);

}

export async function deactivate() {
	logWarning("🔄 lipcoder deactivate starting...");
	
	// Create a force exit timeout as absolute last resort
	const forceExitTimer = setTimeout(() => {
		logError("💀 FORCE EXIT: Extension deactivation took too long, forcing process exit");
		// Try graceful exit first
		try {
			process.exit(0);
		} catch {
			// If that fails, force kill
			process.kill(process.pid, 'SIGKILL');
		}
	}, 8000); // 8 second timeout
	
	try {
			// Stop memory monitoring first
	stopMemoryMonitoring();
	
	// Stop all servers
	try {
		await serverManager.stopServers();
		logSuccess('✅ All servers stopped');
	} catch (error) {
		logError(`❌ Failed to stop servers: ${error}`);
	}
		
		// Dispose all VS Code subscriptions immediately
		try {
			const context = (global as any).lipcoderContext;
			if (context && context.subscriptions) {
				logWarning(`🧹 Disposing ${context.subscriptions.length} VS Code subscriptions...`);
				context.subscriptions.forEach((disposable: vscode.Disposable) => {
					try {
						disposable.dispose();
					} catch (err) {
						// Ignore disposal errors
					}
				});
				context.subscriptions.length = 0; // Clear array
				logSuccess('✅ All VS Code subscriptions disposed');
			}
		} catch (err) {
			logError(`❌ Failed to dispose VS Code subscriptions: ${err}`);
		}
		
		// Force stop all audio immediately
		try {
			const { stopPlayback, cleanupAudioResources } = require('./audio');
			stopPlayback();
			cleanupAudioResources();
			logSuccess('✅ Audio resources cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup audio: ${err}`);
		}
		
		// Aggressive language client cleanup
		try {
			const { emergencyStopLanguageClient } = require('./language_client');
			emergencyStopLanguageClient();
			logSuccess('✅ Language client stopped');
		} catch (err) {
			logError(`❌ Failed to cleanup language client: ${err}`);
		}
		
		// Clean up all ASRClient instances
		const asrModules = [
			'./features/asr_streaming',
			'./features/toggle_asr', 
			'./features/push_to_talk_asr'
		];
		
		asrModules.forEach((modulePath, index) => {
			try {
				const module = require(modulePath);
				const client = module.getASRClient();
				if (client) {
					if (client.getRecordingStatus()) {
						client.stopStreaming();
					}
					client.dispose();
					logSuccess(`✅ ASR client ${index + 1} cleaned up`);
				}
			} catch (err) {
				logError(`❌ Failed to cleanup ASR client ${index + 1}: ${err}`);
			}
		});
		
		// Clean up LLM resources
		try {
			const { cleanupLLMResources } = require('./llm');
			cleanupLLMResources();
			logSuccess('✅ LLM resources cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup LLM: ${err}`);
		}
		
		// Clean up all preloaded caches
		try {
			const { cleanupPreloadedCaches } = require('./preload');
			cleanupPreloadedCaches();
			logSuccess('✅ Preloaded caches cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup preloaded caches: ${err}`);
		}
		
		// Force garbage collection
		if (global.gc) {
			try {
				global.gc();
				logSuccess('🗑️ Forced garbage collection');
			} catch (err) {
				logError(`❌ Failed to force GC: ${err}`);
			}
		}
		
		// Clear the force exit timeout
		clearTimeout(forceExitTimer);
		
		// Final memory report
		const finalMemory = process.memoryUsage();
		logMemory(`[Memory] Final: Heap: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB, RSS: ${(finalMemory.rss / 1024 / 1024).toFixed(2)}MB`);
		
		logSuccess("✅ lipcoder deactivation complete");
		
	} catch (error) {
		logError(`💥 Critical error during deactivation: ${error}`);
		clearTimeout(forceExitTimer);
		
		// If deactivation fails completely, force exit immediately
		logError("💀 Deactivation failed, forcing immediate exit");
		setTimeout(() => process.exit(0), 100);
	}
}