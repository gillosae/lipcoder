#!/usr/bin/env node

/**
 * Node.js 경로 자동 감지 스크립트
 * VS Code launch.json에서 사용할 수 있는 Node.js 경로를 찾습니다.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function expandGlobPaths(globPattern) {
    try {
        // 간단한 glob 패턴 처리 (*/bin/node 형태)
        const parts = globPattern.split('*');
        if (parts.length === 2) {
            const basePath = parts[0];
            const suffix = parts[1];
            
            if (fs.existsSync(basePath)) {
                const dirs = fs.readdirSync(basePath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => path.join(basePath, dirent.name, suffix))
                    .filter(fullPath => fs.existsSync(fullPath));
                return dirs;
            }
        }
    } catch (e) {
        // 에러 무시
    }
    return [];
}

function findNodePath() {
    let possiblePaths = [
        // 현재 실행 중인 Node.js 경로 (가장 우선)
        process.execPath,
        
        // 일반적인 Node.js 설치 경로들
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
        '/bin/node',
        
        // nvm 경로들
        process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : null,
        
        // 시스템 PATH에서 찾기
        ...(process.env.PATH ? process.env.PATH.split(':').map(p => path.join(p, 'node')) : []),
    ].filter(Boolean);

    // Glob 패턴 경로들 확장
    const globPatterns = [
        process.env.HOME ? path.join(process.env.HOME, '.nvm/versions/node/*/bin/node') : null,
        '/opt/homebrew/Cellar/node/*/bin/node',
        '/usr/local/Cellar/node/*/bin/node',
    ].filter(Boolean);

    for (const pattern of globPatterns) {
        possiblePaths.push(...expandGlobPaths(pattern));
    }

    // which/where 명령어로 찾기
    try {
        const whichResult = execSync('which node', { encoding: 'utf8' }).trim();
        if (whichResult && fs.existsSync(whichResult)) {
            possiblePaths.unshift(whichResult);
        }
    } catch (e) {
        // which 명령어 실패 시 무시
    }

    // 경로들을 테스트해서 실제로 작동하는 것 찾기
    for (const nodePath of possiblePaths) {
        if (fs.existsSync(nodePath)) {
            try {
                // Node.js 버전 확인으로 유효성 테스트
                const version = execSync(`"${nodePath}" --version`, { encoding: 'utf8' }).trim();
                console.log(`✅ Found Node.js at: ${nodePath} (${version})`);
                return nodePath;
            } catch (e) {
                console.log(`❌ Invalid Node.js at: ${nodePath}`);
            }
        }
    }

    throw new Error('❌ Could not find a valid Node.js installation');
}

function removeJsonComments(jsonString) {
    // JSON 주석 제거 (// 및 /* */ 스타일)
    return jsonString
        .replace(/\/\*[\s\S]*?\*\//g, '') // /* */ 주석 제거
        .replace(/\/\/.*$/gm, ''); // // 주석 제거
}

function updateLaunchJson(nodePath) {
    const launchJsonPath = path.join(__dirname, '..', '.vscode', 'launch.json');
    
    if (!fs.existsSync(launchJsonPath)) {
        console.log('❌ launch.json not found');
        return false;
    }

    try {
        const rawContent = fs.readFileSync(launchJsonPath, 'utf8');
        const cleanContent = removeJsonComments(rawContent);
        const launchConfig = JSON.parse(cleanContent);
        
        // Launch Server 설정 업데이트
        const serverConfig = launchConfig.configurations.find(config => config.name === 'Launch Server');
        if (serverConfig) {
            serverConfig.runtimeExecutable = nodePath;
            console.log(`✅ Updated Launch Server runtimeExecutable to: ${nodePath}`);
        }

        // 원본 파일의 형식을 유지하면서 업데이트
        let updatedContent = rawContent;
        
        // runtimeExecutable 라인을 찾아서 업데이트하거나 추가
        const serverConfigStart = updatedContent.indexOf('"name": "Launch Server"');
        if (serverConfigStart !== -1) {
            const configEnd = updatedContent.indexOf('}', serverConfigStart);
            const beforeConfig = updatedContent.substring(0, configEnd);
            const afterConfig = updatedContent.substring(configEnd);
            
            // runtimeExecutable이 이미 있는지 확인
            if (beforeConfig.includes('"runtimeExecutable"')) {
                // 기존 runtimeExecutable 업데이트
                updatedContent = updatedContent.replace(
                    /"runtimeExecutable":\s*"[^"]*"/,
                    `"runtimeExecutable": "${nodePath}"`
                );
            } else {
                // runtimeExecutable 추가
                const insertPoint = beforeConfig.lastIndexOf(',') + 1;
                const beforeInsert = updatedContent.substring(0, insertPoint);
                const afterInsert = updatedContent.substring(insertPoint);
                updatedContent = beforeInsert + 
                    `\n\t\t\t"runtimeExecutable": "${nodePath}",` + 
                    afterInsert;
            }
        }

        // 파일 저장
        fs.writeFileSync(launchJsonPath, updatedContent);
        console.log('✅ launch.json updated successfully');
        return true;
    } catch (e) {
        console.error(`❌ Failed to update launch.json: ${e.message}`);
        return false;
    }
}

function main() {
    console.log('🔍 Searching for Node.js installation...');
    console.log(`   Current Node.js: ${process.version} at ${process.execPath}`);
    
    try {
        const nodePath = findNodePath();
        console.log(`\n📍 Node.js found at: ${nodePath}`);
        
        // Node.js 버전 확인
        try {
            const version = execSync(`"${nodePath}" --version`, { encoding: 'utf8' }).trim();
            const versionNumber = parseFloat(version.replace('v', ''));
            
            if (versionNumber < 16.0) {
                console.log(`\n⚠️  Warning: Node.js ${version} is older than recommended (16.0+)`);
                console.log('   Consider upgrading for better compatibility.');
            } else {
                console.log(`✅ Node.js version ${version} is compatible`);
            }
        } catch (e) {
            console.log('⚠️  Could not verify Node.js version');
        }
        
        // launch.json 업데이트
        const updated = updateLaunchJson(nodePath);
        
        if (updated) {
            console.log('\n🎉 Setup complete! You can now run the extension with F5.');
            console.log('\n💡 Next steps:');
            console.log('   1. Run "npm run build" to compile the extension');
            console.log('   2. Press F5 in VS Code to start debugging');
            console.log('   3. If errors occur, restart VS Code and try again');
        }
        
    } catch (e) {
        console.error(`\n${e.message}`);
        console.log('\n🛠️  Troubleshooting steps:');
        console.log('   1. Check if Node.js is installed: node --version');
        console.log('   2. Install Node.js from https://nodejs.org/ (version 16+ recommended)');
        console.log('   3. On macOS with Homebrew: brew install node');
        console.log('   4. Restart your terminal/VS Code after installation');
        console.log('   5. Run this script again: npm run setup-node');
        console.log('\n📋 Your system info:');
        console.log(`   Platform: ${process.platform}`);
        console.log(`   Architecture: ${process.arch}`);
        console.log(`   PATH: ${process.env.PATH?.split(':').slice(0, 3).join(', ')}...`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { findNodePath, updateLaunchJson };
