# LipCoder 맥 간 이전 가이드 (Mac-to-Mac Migration Guide)

이 가이드는 LipCoder 프로젝트를 다른 맥으로 이전할 때 필요한 모든 단계를 설명합니다.

## 🐍 새로운 가상환경 시스템 (v1.0+)

LipCoder는 이제 **Python 가상환경 기반 의존성 관리**를 사용합니다!

### 가상환경의 장점
- ✅ **완전한 격리**: 시스템 Python과 분리된 독립적인 환경
- ✅ **정확한 버전**: 테스트된 정확한 패키지 버전 사용 (당신의 시스템과 동일)
- ✅ **충돌 방지**: 다른 프로젝트와의 패키지 버전 충돌 없음
- ✅ **쉬운 관리**: 한 번 설정하면 자동으로 관리

## 🚀 새로운 맥에서의 설치 과정

### 1단계: 기본 도구 설치

```bash
# Homebrew 설치 (아직 없다면)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 기본 도구들 설치
brew install python@3.10 python@3.11 node npm git ffmpeg sox
```

### 2단계: LipCoder 프로젝트 클론

```bash
# 프로젝트 클론
git clone <your-lipcoder-repo-url>
cd lipcoder

# Node.js 의존성 설치
npm install

# 프로젝트 빌드
npm run build
```

### 3단계: VS Code에서 LipCoder 실행

1. **VS Code에서 프로젝트 열기**
   ```bash
   code .
   ```

2. **F5 키를 눌러 LipCoder 확장 실행**

3. **가상환경 설정 안내가 나타나면:**
   - **"🚀 지금 설정하기"** 클릭
   - 자동으로 가상환경 생성 및 패키지 설치 (3-5분 소요)
   - 설치 완료까지 기다리기

## 🎯 자동 설치되는 내용

### Python 가상환경 (`server/lipcoder_venv/`)
LipCoder 전용 가상환경에 다음 패키지들이 정확한 버전으로 설치됩니다:

```
Flask==2.3.3              # 웹 서버 프레임워크
flask-cors==6.0.1          # CORS 지원
uvicorn==0.35.0            # ASGI 서버
asgiref==3.9.1             # ASGI 유틸리티

torch==2.8.0               # PyTorch 딥러닝
torchaudio==2.8.0          # PyTorch 오디오
torchvision==0.23.0        # PyTorch 비전
TTS==0.22.0                # Coqui 음성 합성

soundfile==0.12.1          # 오디오 파일 처리
numpy==1.22.0              # 수치 계산

# 추가 의존성들
pytorch-lightning==2.4.0
torchmetrics==1.6.0
torchsde==0.2.6
torchdiffeq==0.2.5
clip-anytorch==2.6.0
```

### Node.js 네이티브 모듈
- **node-pty**: 터미널 기능 (자동 재빌드 지원)
- **speaker**: 오디오 출력 (선택사항)

## 🛠️ 수동 관리 명령어

VS Code 명령 팔레트 (Cmd+Shift+P)에서 사용 가능:

### 가상환경 관리
- **`LipCoder: Setup Python Virtual Environment`** - 가상환경 설정
- **`LipCoder: Check Virtual Environment Status`** - 상태 확인
- **`LipCoder: Reset Virtual Environment`** - 완전 재설정

### 네이티브 모듈 관리
- **`LipCoder: Check Native Modules`** - node-pty, speaker 상태 확인

## 🔧 터미널에서 수동 체크

### 가상환경 상태 확인
```bash
# 가상환경 존재 확인
ls -la server/lipcoder_venv/

# 가상환경 Python 확인
server/lipcoder_venv/bin/python --version

# 설치된 패키지 확인
server/lipcoder_venv/bin/pip list
```

### Node.js 네이티브 모듈 확인
```bash
# node-pty 테스트
node -e "try { require('node-pty'); console.log('✅ node-pty: OK'); } catch(e) { console.log('❌ node-pty:', e.message); }"

# speaker 테스트
node -e "try { require('speaker'); console.log('✅ speaker: OK'); } catch(e) { console.log('❌ speaker:', e.message); }"
```

### 터미널에서 사용 가능한 스크립트
```bash
# Node.js 경로 설정 및 빌드
npm run setup

# Node.js 경로만 설정
npm run setup-node

# 프로젝트 빌드
npm run build
npm run compile
```

## 🚨 문제 해결

### Node.js 네이티브 모듈 문제
Node.js 버전이 바뀌면 네이티브 모듈을 재빌드해야 합니다:

```bash
# 개별 모듈 재빌드
npm rebuild node-pty
npm rebuild speaker

# 모든 네이티브 모듈 재빌드
npm rebuild

# 소스에서 다시 빌드
npm install --build-from-source
```

**참고**: 네이티브 모듈들은 선택사항이며, 없어도 LipCoder는 fallback 기능으로 동작합니다.

### "Can't find Node.js binary" 오류
F5로 확장 실행 시 이 오류가 나타나면:

```bash
# 자동 해결
npm run setup-node

# 또는 수동으로 launch.json 업데이트
# .vscode/launch.json에서 "Launch Server" 설정의 runtimeExecutable 확인
```

### Python 가상환경 문제
가상환경에 문제가 있으면:

1. **VS Code에서**: `LipCoder: Reset Virtual Environment` 실행
2. **터미널에서**: 
   ```bash
   # 가상환경 완전 삭제
   rm -rf server/lipcoder_venv
   
   # VS Code에서 F5 실행하여 재설정
   ```

### 가상환경 수동 생성 (고급 사용자)
```bash
# 가상환경 생성
python3 -m venv server/lipcoder_venv

# 가상환경 활성화
source server/lipcoder_venv/bin/activate

# 패키지 설치
pip install -r server/requirements_lipcoder.txt

# 설치 확인
python -c "import torch, TTS, flask; print('All packages OK')"
```

## 📁 중요한 파일들

### 새로 생성되는 파일들
- `server/lipcoder_venv/` - Python 가상환경 디렉토리
- `server/requirements_lipcoder.txt` - Python 패키지 목록
- `.node-version-cache` - Node.js 버전 캐시 (자동 재빌드용)

### 기존 설정 파일들
- `.vscode/launch.json` - VS Code 디버깅 설정
- `package.json` - Node.js 의존성 및 스크립트
- `.gitignore` - Git 무시 파일 목록

## 🎉 완료 확인

모든 설정이 완료되면:

1. ✅ VS Code에서 F5로 LipCoder 확장이 정상 실행
2. ✅ 가상환경 상태 확인에서 "정상적으로 설정되어 있습니다" 메시지
3. ✅ 네이티브 모듈 관련 오류 없음
4. ✅ LipCoder의 모든 TTS/ASR 기능 사용 가능

## 💡 팁

- **첫 설정**: 가상환경 설정은 처음 한 번만 하면 됩니다
- **자동 관리**: Node.js 버전이 바뀌면 자동으로 네이티브 모듈을 재빌드합니다
- **독립성**: 가상환경은 완전히 독립적이므로 시스템 Python에 영향을 주지 않습니다
- **백업**: `server/lipcoder_venv/` 폴더는 백업하지 마세요 (용량이 크고 재생성 가능)

이제 LipCoder를 새로운 맥에서도 안정적으로 사용할 수 있습니다! 🚀
