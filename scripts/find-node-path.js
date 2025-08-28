#!/usr/bin/env node

/**
 * Node.js 경로 자동 감지 스크립트
 * VS Code launch.json에서 사용할 수 있는 Node.js 경로를 찾습니다.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findNodePath() {
    const possiblePaths = [
        // 일반적인 Node.js 설치 경로들
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
        '/bin/node',
        
        // nvm 경로들
        process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : null,
        
        // 현재 실행 중인 Node.js 경로
        process.execPath,
    ].filter(Boolean);

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
    
    try {
        const nodePath = findNodePath();
        console.log(`\n📍 Node.js found at: ${nodePath}`);
        
        // launch.json 업데이트
        const updated = updateLaunchJson(nodePath);
        
        if (updated) {
            console.log('\n🎉 Setup complete! You can now run the extension with F5.');
            console.log('\n💡 If you still get errors, try:');
            console.log('   1. Restart VS Code');
            console.log('   2. Run "npm run build" first');
            console.log('   3. Check that dist/server/server.js exists');
        }
        
    } catch (e) {
        console.error(`\n${e.message}`);
        console.log('\n🛠️  Manual setup required:');
        console.log('   1. Install Node.js from https://nodejs.org/');
        console.log('   2. Restart your terminal/VS Code');
        console.log('   3. Run this script again');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { findNodePath, updateLaunchJson };
