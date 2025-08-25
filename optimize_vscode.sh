#!/bin/bash

echo "🚀 VS Code 성능 최적화 스크립트"
echo "================================"

# 1. VS Code 프로세스 정리
echo "1. VS Code 프로세스 정리 중..."
killall "Visual Studio Code" 2>/dev/null || echo "   VS Code가 실행 중이 아닙니다"
killall "Code Helper" 2>/dev/null || echo "   Code Helper가 실행 중이 아닙니다"

# 2. VS Code 캐시 정리
echo "2. VS Code 캐시 정리 중..."
rm -rf ~/Library/Caches/com.microsoft.VSCode* 2>/dev/null || echo "   VS Code 캐시가 없습니다"
rm -rf ~/.vscode/extensions/.obsolete 2>/dev/null || echo "   obsolete 확장 프로그램이 없습니다"

# 3. TypeScript 캐시 정리
echo "3. TypeScript 캐시 정리 중..."
rm -rf ~/Library/Caches/typescript 2>/dev/null || echo "   TypeScript 캐시가 없습니다"

# 4. 프로젝트 빌드 캐시 정리
echo "4. 프로젝트 빌드 캐시 정리 중..."
cd "$(dirname "$0")"
rm -rf dist/ 2>/dev/null || echo "   dist 폴더가 없습니다"
rm -rf client/dist/ 2>/dev/null || echo "   client/dist 폴더가 없습니다"
rm -rf server/dist/ 2>/dev/null || echo "   server/dist 폴더가 없습니다"
rm -rf shared/dist/ 2>/dev/null || echo "   shared/dist 폴더가 없습니다"

# 5. 큰 파일들 확인
echo "5. 큰 파일들 확인 중..."
echo "   프로젝트 크기:"
du -sh . 2>/dev/null
echo "   가장 큰 디렉토리들:"
du -sh */ 2>/dev/null | sort -hr | head -5

# 6. VS Code 설정 확인
echo "6. VS Code 설정 확인 중..."
if [ -f ".vscode/settings.json" ]; then
    echo "   ✅ VS Code 설정 파일이 존재합니다"
else
    echo "   ⚠️  VS Code 설정 파일을 생성합니다..."
    mkdir -p .vscode
    cat > .vscode/settings.json << 'EOF'
{
    "files.exclude": {
        "**/node_modules": true,
        "**/client/src/python": true,
        "**/client/src/models": true,
        "**/.git": true,
        "**/.DS_Store": true,
        "**/dist": true,
        "**/*.wav": true,
        "**/*.pcm": true,
        "**/*.pt": true,
        "**/*.so": true,
        "**/*.dylib": true
    },
    "search.exclude": {
        "**/node_modules": true,
        "**/client/src/python": true,
        "**/client/src/models": true,
        "**/dist": true,
        "**/*.wav": true,
        "**/*.pcm": true,
        "**/*.pt": true
    },
    "files.watcherExclude": {
        "**/node_modules/**": true,
        "**/client/src/python/**": true,
        "**/client/src/models/**": true,
        "**/dist/**": true,
        "**/*.wav": true,
        "**/*.pcm": true,
        "**/*.pt": true
    },
    "typescript.preferences.includePackageJsonAutoImports": "off",
    "typescript.suggest.autoImports": false
}
EOF
fi

# 7. 시스템 리소스 확인
echo "7. 시스템 리소스 확인 중..."
echo "   메모리 사용량:"
vm_stat | head -4
echo "   CPU 로드:"
uptime

echo ""
echo "✅ 최적화 완료!"
echo ""
echo "📋 추가 권장사항:"
echo "   1. VS Code를 다시 시작하세요"
echo "   2. 필요없는 확장 프로그램을 비활성화하세요"
echo "   3. 큰 파일들은 VS Code 외부에서 편집하세요"
echo "   4. Git에서 큰 바이너리 파일들을 제외하세요"
echo ""
echo "🎯 성능 모니터링:"
echo "   - Activity Monitor에서 'Code Helper' 프로세스 확인"
echo "   - CPU 사용률이 100%를 넘지 않는지 확인"
echo "   - 메모리 사용량이 2GB를 넘지 않는지 확인"
