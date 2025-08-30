#!/usr/bin/env node

console.log('🎤 마이크 테스트 스크립트 시작...');
console.log('====================================');

// 1. node-microphone 테스트
console.log('\n1️⃣ node-microphone 패키지 테스트...');
try {
    const Microphone = require('node-microphone');
    console.log('✅ node-microphone 패키지 로드 성공');
    
    const mic = new Microphone({
        rate: 16000,
        channels: 1,
        debug: false,
        exitOnSilence: 6
    });
    console.log('✅ node-microphone 인스턴스 생성 성공');
    
    const audioStream = mic.startRecording();
    console.log('✅ node-microphone 녹음 시작 성공');
    
    let chunkCount = 0;
    let totalBytes = 0;
    
    audioStream.on('data', (chunk) => {
        chunkCount++;
        totalBytes += chunk.length;
        console.log(`🎤 [node-microphone] 오디오 청크 #${chunkCount}: ${chunk.length} bytes (총 ${totalBytes} bytes)`);
        
        if (chunkCount >= 5) {
            console.log('✅ node-microphone 테스트 완료 - 오디오 데이터 수신 성공!');
            mic.stopRecording();
            testMicPackage();
        }
    });
    
    audioStream.on('error', (error) => {
        console.error('❌ node-microphone 에러:', error);
        testMicPackage();
    });
    
    // 5초 후에도 데이터가 없으면 실패
    setTimeout(() => {
        if (chunkCount === 0) {
            console.error('❌ node-microphone: 5초 동안 오디오 데이터 없음');
            mic.stopRecording();
            testMicPackage();
        }
    }, 5000);
    
} catch (error) {
    console.error('❌ node-microphone 패키지 에러:', error);
    testMicPackage();
}

// 2. mic 패키지 테스트
function testMicPackage() {
    console.log('\n2️⃣ mic 패키지 테스트...');
    try {
        const mic = require('mic');
        console.log('✅ mic 패키지 로드 성공');
        
        const micInstance = mic({
            rate: 16000,
            channels: '1',
            debug: false,
            exitOnSilence: 6
        });
        console.log('✅ mic 인스턴스 생성 성공');
        
        const audioStream = micInstance.getAudioStream();
        micInstance.start();
        console.log('✅ mic 녹음 시작 성공');
        
        let chunkCount = 0;
        let totalBytes = 0;
        
        audioStream.on('data', (chunk) => {
            chunkCount++;
            totalBytes += chunk.length;
            console.log(`🎤 [mic] 오디오 청크 #${chunkCount}: ${chunk.length} bytes (총 ${totalBytes} bytes)`);
            
            if (chunkCount >= 5) {
                console.log('✅ mic 패키지 테스트 완료 - 오디오 데이터 수신 성공!');
                micInstance.stop();
                testSystemMicrophone();
            }
        });
        
        audioStream.on('error', (error) => {
            console.error('❌ mic 패키지 에러:', error);
            testSystemMicrophone();
        });
        
        // 5초 후에도 데이터가 없으면 실패
        setTimeout(() => {
            if (chunkCount === 0) {
                console.error('❌ mic 패키지: 5초 동안 오디오 데이터 없음');
                micInstance.stop();
                testSystemMicrophone();
            }
        }, 5000);
        
    } catch (error) {
        console.error('❌ mic 패키지 에러:', error);
        testSystemMicrophone();
    }
}

// 3. 시스템 마이크 테스트
function testSystemMicrophone() {
    console.log('\n3️⃣ 시스템 명령어 확인...');
    
    const { spawn } = require('child_process');
    
    // rec 명령어 존재 여부 확인
    const which = spawn('which', ['rec']);
    
    which.on('close', (code) => {
        if (code === 0) {
            console.log('✅ rec 명령어 존재함 - SoX 설치됨');
            // 실제 녹음 테스트
            const rec = spawn('rec', ['-t', 'wav', '/tmp/test_mic.wav', 'trim', '0', '1']);
            rec.on('close', (recCode) => {
                if (recCode === 0) {
                    console.log('✅ 시스템 마이크 테스트 성공');
                } else {
                    console.error('❌ 시스템 마이크 테스트 실패');
                }
                showSummary();
            });
        } else {
            console.error('❌ rec 명령어 없음 - SoX 미설치');
            console.log('💡 해결방법: brew install sox');
            showSummary();
        }
    });
    
    which.on('error', (error) => {
        console.error('❌ which 명령어 에러:', error);
        showSummary();
    });
}

// 4. 결과 요약
function showSummary() {
    console.log('\n📋 테스트 결과 요약');
    console.log('====================================');
    console.log('위 로그를 확인하여:');
    console.log('- ✅가 많으면: 마이크 패키지는 정상, VS Code 설정 문제');
    console.log('- ❌가 많으면: 마이크 권한 또는 하드웨어 문제');
    console.log('- 오디오 청크가 나오면: 마이크 데이터 수신 정상');
    console.log('- 오디오 청크가 없으면: 마이크 권한 문제');
    console.log('\n🔧 문제 해결 방법:');
    console.log('1. SoX 설치: brew install sox');
    console.log('2. 시스템 환경설정 → 보안 및 개인정보보호 → 개인정보보호 → 마이크');
    console.log('3. Terminal.app과 VS Code 모두 체크 확인');
    console.log('4. sudo tccutil reset Microphone 실행 후 재시도');
    
    process.exit(0);
}
