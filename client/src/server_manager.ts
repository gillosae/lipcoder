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
        this.serverDirectory = path.join(__dirname, '../../server');
        
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
        
        this.servers.set('asr', {
            name: 'ASR Server', 
            script: 'start_asr.sh',
            defaultPort: 5004
        });
    }



    // Check if a port is available
    private async isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.listen(port, () => {
                server.close(() => resolve(true));
            });
            server.on('error', () => resolve(false));
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

        // Check if server is already running
        if (config.process && !config.process.killed && config.process.exitCode === null) {
            log(`[ServerManager] ${config.name} is already running on port ${config.actualPort}`);
            return;
        }

        // Find available port
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
            throw new Error(`Script not found: ${scriptPath}`);
        }

        try {
            fs.accessSync(scriptPath, fs.constants.X_OK);
        } catch (error) {
            throw new Error(`Script not executable: ${scriptPath}`);
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

    // Start all servers (modified to only start default TTS backend)
    async startServers(): Promise<void> {
        log('[ServerManager] Starting servers with default TTS backend...');
        
        try {
            await Promise.all([
                this.startServer('tts'),  // Start with Silero as default
                this.startServer('asr')   // Always start ASR
                // Don't start espeak_tts by default - it will be started when user switches
            ]);
            logSuccess('✅ Default servers started successfully');
        } catch (error) {
            logError(`Failed to start servers: ${error}`);
            // Clean up any partially started servers
            await this.stopServers();
            throw error;
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
    async switchTTSBackend(newBackend: 'silero' | 'espeak'): Promise<void> {
        const currentTTSServers = ['tts', 'espeak_tts'];
        
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
        const targetServer = newBackend === 'silero' ? 'tts' : 'espeak_tts';
        await this.startIndividualServer(targetServer);
        
        logSuccess(`✅ TTS backend switched to ${newBackend}`);
    }
}

// Global server manager instance
const serverManager = new ServerManager();

export { serverManager };
export type { ServerConfig }; 