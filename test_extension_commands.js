// VS Code 확장 명령어 테스트 스크립트
// F12 개발자 도구 콘솔에서 실행

console.log("=== LipCoder Extension Commands Test ===");

// 등록된 모든 명령어 확인
vscode.commands.getCommands(true).then(commands => {
    const lipcoderCommands = commands.filter(cmd => cmd.startsWith('lipcoder.'));
    console.log("등록된 LipCoder 명령어들:");
    lipcoderCommands.forEach(cmd => console.log(`  - ${cmd}`));
    
    // XTTS 관련 명령어 확인
    const xttsCommands = lipcoderCommands.filter(cmd => cmd.includes('XTTS') || cmd.includes('xtts'));
    console.log("\nXTTS 관련 명령어들:");
    xttsCommands.forEach(cmd => console.log(`  - ${cmd}`));
    
    // 특정 명령어들 확인
    const targetCommands = [
        'lipcoder.testXTTSInference',
        'lipcoder.quickEnglishXTTS',
        'lipcoder.quickKoreanXTTS',
        'lipcoder.checkXTTSStatus',
        'lipcoder.clearXTTSCache'
    ];
    
    console.log("\n찾고 있는 명령어들:");
    targetCommands.forEach(cmd => {
        const exists = commands.includes(cmd);
        console.log(`  - ${cmd}: ${exists ? '✅ 등록됨' : '❌ 없음'}`);
    });
});

// 명령어 직접 실행 테스트
console.log("\n명령어 직접 실행 테스트:");
vscode.commands.executeCommand('lipcoder.testXTTSInference')
    .then(() => console.log("✅ testXTTSInference 실행 성공"))
    .catch(err => console.log("❌ testXTTSInference 실행 실패:", err));
