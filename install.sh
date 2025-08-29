#!/bin/bash

# LipCoder 자동 설치 스크립트
# 이 스크립트는 LipCoder를 설치하고 설정하는 과정을 자동화합니다.

set -e  # 에러 발생 시 스크립트 중단

echo "🚀 LipCoder 설치를 시작합니다..."
echo ""

# Node.js 설치 확인
echo "🔍 Node.js 설치 상태를 확인합니다..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js가 설치되어 있지 않습니다."
    echo ""
    echo "Node.js를 설치해주세요:"
    echo "  방법 1: https://nodejs.org/ 에서 다운로드"
    echo "  방법 2: Homebrew 사용 - brew install node"
    echo ""
    exit 1
fi

NODE_VERSION=$(node --version)
echo "✅ Node.js $NODE_VERSION 발견"

# Node.js 버전 확인 (16.0 이상 권장)
NODE_MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
if [ "$NODE_MAJOR_VERSION" -lt 16 ]; then
    echo "⚠️  경고: Node.js $NODE_VERSION은 권장 버전(16.0+)보다 낮습니다."
    echo "   업그레이드를 고려해보세요."
    echo ""
fi

# npm 설치 확인
if ! command -v npm &> /dev/null; then
    echo "❌ npm이 설치되어 있지 않습니다."
    echo "Node.js와 함께 npm을 설치해주세요."
    exit 1
fi

NPM_VERSION=$(npm --version)
echo "✅ npm $NPM_VERSION 발견"
echo ""

# 의존성 설치
echo "📦 의존성을 설치합니다..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install 실패"
    echo ""
    echo "문제 해결 방법:"
    echo "  1. npm cache clean --force"
    echo "  2. rm -rf node_modules package-lock.json"
    echo "  3. npm install 다시 실행"
    exit 1
fi

echo "✅ 의존성 설치 완료"
echo ""

# 빌드
echo "🔨 프로젝트를 빌드합니다..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ 빌드 실패"
    echo "TypeScript 컴파일 오류를 확인해주세요."
    exit 1
fi

echo "✅ 빌드 완료"
echo ""

# Node.js 경로 설정
echo "⚙️  Node.js 경로를 설정합니다..."
npm run setup-node

if [ $? -ne 0 ]; then
    echo "⚠️  Node.js 경로 설정에 실패했지만 계속 진행합니다."
fi

# Python 가상환경 경로 수정
echo "🐍 Python 가상환경 경로를 수정합니다..."
if [ -f "./fix_python_paths.py" ]; then
    python3 ./fix_python_paths.py
    if [ $? -eq 0 ]; then
        echo "✅ Python 경로 수정 완료"
    else
        echo "⚠️  Python 경로 수정에 실패했지만 계속 진행합니다."
    fi
else
    echo "⚠️  Python 경로 수정 스크립트를 찾을 수 없습니다."
fi

echo ""
echo "🎉 LipCoder 설치가 완료되었습니다!"
echo ""
echo "다음 단계:"
echo "  1. VS Code에서 이 폴더를 엽니다"
echo "  2. F5를 눌러 확장 프로그램을 실행합니다"
echo "  3. 새 VS Code 창이 열리면 LipCoder가 활성화됩니다"
echo ""
echo "문제가 발생하면:"
echo "  - VS Code를 재시작해보세요"
echo "  - README.md의 문제 해결 섹션을 확인하세요"
echo "  - GitHub Issues에 문제를 보고해주세요"
echo ""
echo "즐거운 코딩 되세요! 🎵"
