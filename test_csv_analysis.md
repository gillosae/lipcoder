# CSV 파일 분석 기능 테스트 가이드

## 🎯 구현된 기능

"movies.csv 파일에 대해 설명해줘"와 같은 ASR 명령으로 CSV 파일의 구조를 분석하고 설명하는 기능이 추가되었습니다.

## 🗣️ 테스트할 수 있는 음성 명령어

### 한국어 명령어
- **"sample_data.csv 파일에 대해 설명해줘"**
- **"sample_data.csv 구조 알려줘"**
- **"sample_data.csv 파일 분석해줘"**
- **"sample_data.csv에 어떤 컬럼이 있는지 말해줘"**
- **"CSV 파일 sample_data.csv 설명해줘"**

### 영어 명령어
- **"analyze sample_data.csv file"**
- **"tell me about sample_data.csv"**
- **"describe sample_data.csv structure"**
- **"explain sample_data.csv file"**

## 📊 테스트 데이터

현재 프로젝트에 있는 `sample_data.csv` 파일:
```csv
name,age,role,department,salary,join_date
John Smith,28,Software Engineer,Engineering,75000,2022-03-15
Sarah Johnson,32,Product Manager,Product,85000,2021-11-20
Mike Chen,25,Junior Developer,Engineering,55000,2023-01-10
Lisa Wang,29,UX Designer,Design,70000,2022-07-08
David Brown,35,Senior Engineer,Engineering,95000,2020-05-12
Emma Davis,27,Marketing Specialist,Marketing,60000,2022-09-03
Alex Rodriguez,31,DevOps Engineer,Engineering,80000,2021-08-15
Jennifer Lee,26,Data Analyst,Analytics,65000,2023-02-20
```

## 🔧 기능 동작 방식

1. **ASR 명령 감지**: 사용자가 CSV 파일 관련 명령을 말하면 자동으로 감지
2. **파일 검색**: 프로젝트 내에서 해당 CSV 파일을 찾음
3. **구조 분석**: Bash 스크립트를 사용하여 파일 구조 분석
4. **음성 피드백**: 파일 정보를 음성으로 읽어줌
5. **상세 보고서**: VS Code 출력 패널에 상세한 분석 결과 표시

## 📋 예상 결과

음성 명령 **"sample_data.csv 파일에 대해 설명해줘"**를 실행하면:

### 음성 피드백
- "Found CSV file sample_data.csv with 9 lines and 6 columns: name, age, role and 3 more"

### 출력 패널 (CSV File Analysis)
```
=== CSV Analysis Report ===
File: sample_data.csv
Size: 510 bytes
Lines: 9
Columns: 6

=== Headers ===
     1	name
     2	age
     3	role
     4	department
     5	salary
     6	join_date

=== Sample Data (first 3 rows) ===
name,age,role,department,salary,join_date
John Smith,28,Software Engineer,Engineering,75000,2022-03-15
Sarah Johnson,32,Product Manager,Product,85000,2021-11-20
Mike Chen,25,Junior Developer,Engineering,55000,2023-01-10

=== File Statistics ===
First row: John Smith,28,Software Engineer,Engineering,75000,2022-03-15
Last row: Jennifer Lee,26,Data Analyst,Analytics,65000,2023-02-20
```

## 🚀 테스트 방법

1. **ASR 시작**: VS Code에서 ASR 기능을 활성화
2. **음성 명령**: 위의 명령어 중 하나를 말하기
3. **결과 확인**: 
   - 음성 피드백 듣기
   - VS Code 출력 패널에서 상세 분석 결과 확인

## 🔍 추가 기능

- **파일명 유연성**: "sample_data"만 말해도 "sample_data.csv" 파일을 찾음
- **오류 처리**: 파일이 없으면 사용 가능한 CSV 파일 목록을 알려줌
- **다국어 지원**: 한국어와 영어 명령 모두 지원
- **실시간 분석**: 실제 파일 내용을 bash 스크립트로 분석

## 🎯 핵심 개선사항

이제 사용자는 단순히 "CSV 파일이 있나요?"가 아닌, **특정 파일에 대한 구체적인 분석**을 요청할 수 있습니다:

- ❌ 이전: 일반적인 답변만 제공
- ✅ 현재: 실제 파일 분석 및 구조 설명 제공
