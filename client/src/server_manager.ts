import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { log, logSuccess, logError, logWarning } from './utils';

interface ServerConfig {
    name: string;
    script: string;
    defaultPort: number;
    actualPort?: number;
    process?: ChildProcess;
}

class ServerManager {
    private servers: Map<string, ServerConfig> = new Map();
    private serverDirectory: string;
    private gunicornPath: string | null = null;

    constructor() {
        // Get the server directory relative to the client (dist/client -> ../../server)
        this.serverDirectory = this.findServerDirectory();
        
        // Initialize server configurations with shell script wrappers
        this.servers.set('tts', {
            name: 'TTS Server',
            script: 'start_tts.sh',
            defaultPort: 5003
        });
        
        this.servers.set('espeak_tts', {
            name: 'Espeak TTS Server',
            script: 'start_espeak_tts.sh',
            defaultPort: 5005
        });
        
        this.servers.set('espeak_tts_2', {
            name: 'Espeak TTS Server 2',
            script: 'start_espeak_tts.sh',
            defaultPort: 5007  // Second espeak server on different port
        });
        
        this.servers.set('asr', {
            name: 'ASR Server', 
            script: 'start_asr.sh',
            defaultPort: 5004
        });
        
        this.servers.set('xtts_v2', {
            name: 'XTTS-v2 Server',
            script: 'start_xtts_v2.sh',
            defaultPort: 5006  // Use unique port for XTTS-v2
        });
        
        this.servers.set('macos_tts', {
            name: 'macOS TTS Server',
            script: 'start_macos_tts.sh',
            defaultPort: 5008  // Use unique port for macOS TTS
        });
        
        this.servers.set('huggingface-whisper', {
            name: 'Hugging Face Whisper ASR Server',
            script: 'start_huggingface_whisper.sh',
            defaultPort: 5005  // Use unique port for Hugging Face Whisper
        });
    }

    private findServerDirectory(): string {
        // Get current directory, with fallback if __dirname is undefined
        const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
        
        // Try different possible server directory locations
        const possiblePaths = [
            // Standard build structure: dist/client -> ../../server
            path.join(currentDir, '../../server'),
            // Development structure: client/src -> ../../server  
            path.join(currentDir, '../../../server'),
            // Alternative: from workspace root
            path.join(process.cwd(), 'server'),
            // If running from different location, try to find server relative to package.json
            path.join(path.dirname(require.resolve('../../package.json')), 'server')
        ];

        for (const serverPath of possiblePaths) {
            try {
                // Check if the directory exists and contains expected files
                if (fs.existsSync(serverPath)) {
                    const expectedFiles = ['start_asr.sh', 'start_macos_tts.sh'];
                    const hasExpectedFiles = expectedFiles.some(file => 
                        fs.existsSync(path.join(serverPath, file))
                    );
                    
                    if (hasExpectedFiles) {
                        log(`[ServerManager] Found server directory: ${serverPath}`);
                        return serverPath;
                    }
                }
            } catch (error) {
                // Continue to next path
                continue;
            }
        }

        // Fallback to the standard path even if it doesn't exist
        const fallbackPath = path.join(currentDir, '../../server');
        logWarning(`[ServerManager] Could not find server directory, using fallback: ${fallbackPath}`);
        return fallbackPath;
    }

    // Check if a port is available
    private async isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            
            server.listen(port, '127.0.0.1', () => {
                server.close(() => {
                    log(`[ServerManager] Port ${port} is available`);
                    resolve(true);
                });
            });
            
            server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    log(`[ServerManager] Port ${port} is already in use`);
                    resolve(false);
                } else {
                    logWarning(`[ServerManager] Port ${port} check error: ${err.message}`);
                    resolve(false);
                }
            });
            
            // Timeout after 2 seconds
            setTimeout(() => {
                server.close(() => {
                    logWarning(`[ServerManager] Port ${port} check timed out`);
                    resolve(false);
                });
            }, 2000);
        });
    }

    // Find an available port starting from the default
    private async findAvailablePort(defaultPort: number): Promise<number> {
        let port = defaultPort;
        while (port < defaultPort + 100) { // Try up to 100 ports
            if (await this.isPortAvailable(port)) {
                return port;
            }
            port++;
        }
        throw new Error(`No available port found starting from ${defaultPort}`);
    }

    // Start a specific server
    private async startServer(serverKey: string): Promise<void> {
        const config = this.servers.get(serverKey);
        if (!config) {
            throw new Error(`Unknown server: ${serverKey}`);
        }

        // Check if server is already running (process-based check)
        if (config.process && !config.process.killed && config.process.exitCode === null) {
            log(`[ServerManager] ${config.name} is already running on port ${config.actualPort}`);
            return;
        }

        // Check if default port is already in use by external process
        const defaultPortInUse = !(await this.isPortAvailable(config.defaultPort));
        if (defaultPortInUse) {
            log(`[ServerManager] ${config.name} default port ${config.defaultPort} is already in use by external process`);
            
            // Try to connect to existing server to verify it's working
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                
                const response = await fetch(`http://localhost:${config.defaultPort}/health`, {
                    method: 'GET',
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    config.actualPort = config.defaultPort;
                    log(`[ServerManager] ✅ Using existing ${config.name} on port ${config.defaultPort}`);
                    return;
                } else {
                    logWarning(`[ServerManager] External server on port ${config.defaultPort} is not responding properly`);
                }
            } catch (error) {
                logWarning(`[ServerManager] Failed to connect to external server on port ${config.defaultPort}: ${error}`);
            }
        }

        // Find available port (only if default port is not usable)
        try {
            config.actualPort = await this.findAvailablePort(config.defaultPort);
            log(`[ServerManager] ${config.name} assigned to port ${config.actualPort}`);
        } catch (error) {
            throw new Error(`Failed to find available port for ${config.name}: ${error}`);
        }

        // Use shell script wrapper to bypass VS Code sandbox restrictions
        const scriptPath = path.join(this.serverDirectory, config.script);
        const args = [config.actualPort.toString()];

        // Verify script exists and is executable
        if (!fs.existsSync(scriptPath)) {
            logError(`[ServerManager] Script not found: ${scriptPath}`);
            logError(`[ServerManager] Server directory: ${this.serverDirectory}`);
            logError(`[ServerManager] Available files: ${fs.existsSync(this.serverDirectory) ? fs.readdirSync(this.serverDirectory).join(', ') : 'directory not found'}`);
            throw new Error(`Script not found: ${scriptPath}`);
        }

        try {
            fs.accessSync(scriptPath, fs.constants.X_OK);
        } catch (error) {
            logWarning(`[ServerManager] Script not executable, attempting to make executable: ${scriptPath}`);
            try {
                // Try to make the script executable
                fs.chmodSync(scriptPath, '755');
                log(`[ServerManager] Made script executable: ${scriptPath}`);
            } catch (chmodError) {
                throw new Error(`Script not executable and cannot be made executable: ${scriptPath}`);
            }
        }

        log(`[ServerManager] Starting ${config.name} using script: ${scriptPath} ${args.join(' ')}`);
        
        // Spawn the shell script with absolute path
        const serverProcess = spawn(scriptPath, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        config.process = serverProcess;

        // Set up logging for spawn
        serverProcess.stdout?.on('data', (data) => {
            log(`[${config.name}] ${data.toString().trim()}`);
        });

        serverProcess.stderr?.on('data', (data) => {
            const message = data.toString().trim();
            if (message.includes('INFO') || message.includes('SUCCESS')) {
                log(`[${config.name}] ${message}`);
            } else {
                logWarning(`[${config.name}] ${message}`);
            }
        });

        serverProcess.on('error', (error) => {
            logError(`[ServerManager] ${config.name} process error: ${error}`);
        });

        serverProcess.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                logError(`[ServerManager] ${config.name} exited with code ${code}`);
            } else {
                log(`[ServerManager] ${config.name} stopped gracefully`);
            }
            config.process = undefined;
        });

        // Wait a bit for the server to start
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify the server is running
        if (serverProcess.killed || serverProcess.exitCode !== null) {
            throw new Error(`${config.name} failed to start`);
        }

        logSuccess(`✅ ${config.name} started successfully on port ${config.actualPort}`);
    }

    // Public method to start a specific server
    async startIndividualServer(serverKey: string): Promise<void> {
        log(`[ServerManager] Starting individual server: ${serverKey}`);
        await this.startServer(serverKey);
    }

    // Public method to stop a specific server
    async stopIndividualServer(serverKey: string): Promise<void> {
        const config = this.servers.get(serverKey);
        if (!config) {
            throw new Error(`Unknown server: ${serverKey}`);
        }

        if (!config.process || config.process.killed || config.process.exitCode !== null) {
            log(`[ServerManager] ${config.name} is not running`);
            return;
        }

        log(`[ServerManager] Stopping ${config.name}...`);
        
        return new Promise((resolve) => {
            const process = config.process!;
            
            // Set up exit handler
            const onExit = () => {
                log(`[ServerManager] ${config.name} stopped`);
                resolve();
            };
            
            process.once('exit', onExit);
            
            // Try graceful shutdown first
            process.kill('SIGTERM');
            
            // Force kill after timeout
            setTimeout(() => {
                if (!process.killed && process.exitCode === null) {
                    logWarning(`[ServerManager] Force killing ${config.name}`);
                    process.kill('SIGKILL');
                }
            }, 3000);
        });
    }

    // Start all servers (modified to start default TTS backend based on config)
    async startServers(): Promise<void> {
        log('[ServerManager] Starting servers with default TTS backend...');
        
        try {
            // Import config to check current backend
            const { currentBackend, TTSBackend } = await import('./config.js');
            
            const serverPromises = [
                this.startServer('asr'),  // Always start ASR (port 5004)
                this.startServer('huggingface-whisper')  // Always start Hugging Face Whisper ASR (port 5005)
            ];
            
            // Start appropriate TTS servers based on current backend
            if (currentBackend === TTSBackend.SileroGPT) {
                serverPromises.push(this.startServer('tts'));  // Silero for English
                log('[ServerManager] Starting Silero TTS for English (Silero+GPT backend)');
            } else if (currentBackend === TTSBackend.EspeakGPT) {
                serverPromises.push(this.startServer('espeak_tts'));  // Espeak for English
                log('[ServerManager] Starting Espeak TTS for English (Espeak+GPT backend)');
            } else if (currentBackend === TTSBackend.Espeak) {
                serverPromises.push(this.startServer('espeak_tts'));    // Primary espeak server
                serverPromises.push(this.startServer('espeak_tts_2'));  // Secondary espeak server for parallel processing
                log('[ServerManager] Starting dual Espeak TTS servers for parallel processing (all languages including Korean)');
            } else if (currentBackend === TTSBackend.XTTSV2) {
                serverPromises.push(this.startServer('xtts_v2'));  // XTTS-v2 for both
                log('[ServerManager] Starting XTTS-v2 for both Korean and English');
            } else if (currentBackend === TTSBackend.MacOSGPT) {
                serverPromises.push(this.startServer('macos_tts'));  // macOS for English
                log('[ServerManager] Starting macOS TTS for English (macOS+GPT backend)');
            } else if (currentBackend === TTSBackend.MacOS) {
                serverPromises.push(this.startServer('macos_tts'));  // macOS for all languages
                log('[ServerManager] Starting macOS TTS for all languages (macOS backend)');
            }
            
            await Promise.all(serverPromises);
            logSuccess(`✅ Default servers started successfully (${currentBackend} + ASR)`);
        } catch (error) {
            logError(`Failed to start servers: ${error}`);
            // Clean up any partially started servers
            await this.stopServers();
            throw error;
        }
    }

    /**
     * Register an existing server without starting a new process
     */
    registerExistingServer(serverId: string, port: number): void {
        const config = this.servers.get(serverId);
        if (config) {
            config.actualPort = port;
            logSuccess(`✅ Registered existing ${config.name} on port ${port}`);
        } else {
            logWarning(`⚠️ Unknown server ID: ${serverId}`);
        }
    }

    // Stop all servers
    async stopServers(): Promise<void> {
        log('[ServerManager] Stopping all servers...');
        
        const stopPromises: Promise<void>[] = [];
        
        for (const [key, config] of this.servers) {
            if (config.process && !config.process.killed) {
                stopPromises.push(new Promise((resolve) => {
                    const process = config.process!;
                    
                    // Set up exit handler
                    const onExit = () => {
                        log(`[ServerManager] ${config.name} stopped`);
                        resolve();
                    };
                    
                    process.once('exit', onExit);
                    
                    // Try graceful shutdown first
                    process.kill('SIGTERM');
                    
                    // Force kill after timeout
                    setTimeout(() => {
                        if (!process.killed && process.exitCode === null) {
                            logWarning(`[ServerManager] Force killing ${config.name}`);
                            process.kill('SIGKILL');
                        }
                    }, 3000);
                }));
            }
        }
        
        if (stopPromises.length > 0) {
            await Promise.all(stopPromises);
        }
        
        logSuccess('✅ All servers stopped');
    }

    // Get the actual port for a server
    getServerPort(serverKey: string): number | undefined {
        const config = this.servers.get(serverKey);
        return config?.actualPort;
    }

    // Get server status
    getServerStatus(): { [key: string]: { name: string; port?: number; running: boolean } } {
        const status: { [key: string]: { name: string; port?: number; running: boolean } } = {};
        
        for (const [key, config] of this.servers) {
            status[key] = {
                name: config.name,
                port: config.actualPort,
                running: !!(config.process && !config.process.killed && config.process.exitCode === null)
            };
        }
        
        return status;
    }

    // Switch TTS backend by stopping current and starting new one
    async switchTTSBackend(newBackend: 'silero' | 'espeak' | 'espeak-all' | 'xtts-v2' | 'macos' | 'macos-all'): Promise<void> {
        const currentTTSServers = ['tts', 'espeak_tts', 'xtts_v2', 'macos_tts'];
        
        log(`[ServerManager] Switching TTS backend to: ${newBackend}`);
        
        // Stop all TTS servers first
        const stopPromises = currentTTSServers.map(async serverKey => {
            const config = this.servers.get(serverKey);
            if (config && config.process && !config.process.killed && config.process.exitCode === null) {
                await this.stopIndividualServer(serverKey);
            }
        });
        
        await Promise.all(stopPromises);
        
        // Start the new TTS server
        let targetServer: string;
        if (newBackend === 'silero') {
            targetServer = 'tts';
        } else if (newBackend === 'espeak' || newBackend === 'espeak-all') {
            targetServer = 'espeak_tts';
        } else if (newBackend === 'xtts-v2') {
            targetServer = 'xtts_v2';
        } else if (newBackend === 'macos' || newBackend === 'macos-all') {
            targetServer = 'macos_tts';
        } else {
            throw new Error(`Unknown TTS backend: ${newBackend}`);
        }
        
        await this.startIndividualServer(targetServer);
        
        logSuccess(`✅ TTS backend switched to ${newBackend}`);
    }
}

// Global server manager instance
const serverManager = new ServerManager();

export { serverManager };
export type { ServerConfig }; 