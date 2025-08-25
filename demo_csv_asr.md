# CSV File Detection with ASR and Bash Scripts

## 🎯 **What's Been Implemented**

The lipcoder ASR system now **automatically executes bash scripts** when you ask about CSV files, instead of providing generic answers.

## 🗣️ **Voice Commands That Trigger Bash Scripts**

When you say any of these phrases, the system will **execute underground bash commands** to check the codebase:

- **"Do we have CSV files in this codebase?"**
- **"Are there any CSV files?"**
- **"Find CSV files in the project"**
- **"Check for CSV files"**
- **"What CSV files are in this codebase?"**
- **"Show me CSV files"**
- **"List CSV files"**

## 🔧 **What Happens Behind the Scenes**

### 1. **ASR Detection**
```typescript
// Detects CSV-related questions using regex patterns
private detectCSVQuestion(text: string): boolean {
    const csvPatterns = [
        /do we have.*csv.*file/i,
        /are there.*csv.*file/i,
        /find.*csv.*file/i,
        /check.*csv.*file/i,
        /csv.*file.*in.*codebase/i,
        // ... more patterns
    ];
    return csvPatterns.some(pattern => pattern.test(text));
}
```

### 2. **Bash Script Execution**
```bash
# Executed automatically when CSV question is detected
cd "/path/to/workspace" && 
find . -name "*.csv" -type f 2>/dev/null | 
while read -r file; do
    if [ -f "$file" ]; then
        size=$(wc -c < "$file" 2>/dev/null || echo "0")
        lines=$(wc -l < "$file" 2>/dev/null || echo "0")
        echo "$file|$size|$lines"
    fi
done
```

### 3. **Real Results from Our Codebase**
```
./sample_data.csv|510|9
./client/src/python/lib/.../umath-validation-set-log2.csv|68917|1629
./client/src/python/lib/.../umath-validation-set-arcsinh.csv|60289|1429
./client/src/python/lib/.../umath-validation-set-arctanh.csv|61339|1429
./client/src/python/lib/.../umath-validation-set-sin.csv|58611|1370
... (and 25+ more numpy test CSV files)
```

## 🎵 **Audio Response**

The system provides **immediate audio feedback**:

- **If CSV files found**: "Found X CSV files: filename1, filename2..."
- **If no CSV files**: "No CSV files found"
- **Includes file details**: Line counts, sizes, locations

## 📋 **Interactive Actions**

After the bash script runs, you get actionable options:

### **If CSV Files Found:**
- 📄 **Show Full Report** - Detailed CSV file report
- 📊 **Analyze CSV** - Deep analysis of specific CSV file  
- 🔍 **Find CSV Files** - Interactive CSV file browser

### **If No CSV Files Found:**
- ➕ **Create Sample CSV** - Generate sample CSV file for testing

## 🚀 **Example Workflow**

1. **You say**: *"Do we have CSV files in this codebase?"*

2. **System executes**: Bash script to scan entire codebase

3. **System speaks**: *"Found 30 CSV files: sample_data.csv, umath-validation-set-log2.csv, and 28 more"*

4. **System shows**: Interactive popup with actions:
   - Show Full Report
   - Analyze CSV  
   - Find CSV Files

5. **You can**: Select an action or continue with voice commands

## 🔧 **Advanced CSV Analysis**

The system can also perform detailed CSV analysis using bash:

```bash
# Advanced CSV analysis script
echo "=== CSV Analysis Report ==="
echo "File: $(basename "$file")"
echo "Size: $(wc -c < "$file") bytes"
echo "Lines: $(wc -l < "$file")"
echo "Columns: $(head -n 1 "$file" | tr ',' '\n' | wc -l)"
echo ""
echo "=== Headers ==="
head -n 1 "$file" | tr ',' '\n' | nl
echo ""
echo "=== Sample Data (first 3 rows) ==="
head -n 4 "$file"
```

## 🎯 **Key Benefits**

1. **Real-time execution** - No generic responses, actual bash commands
2. **Accurate results** - Live data from the actual codebase
3. **Immediate audio feedback** - Spoken results with file details
4. **Interactive actions** - Follow-up options based on results
5. **Comprehensive analysis** - File sizes, line counts, headers, samples

## 🧪 **Testing**

The system has been tested and works with:
- ✅ Our sample_data.csv (9 lines, 510 bytes)
- ✅ 30+ numpy test CSV files in the Python environment
- ✅ Various CSV question phrasings
- ✅ Error handling for missing files or permissions
- ✅ Audio feedback in multiple scenarios

## 🔄 **No More Generic Answers**

**Before**: ASR would show generic suggestions like "You can check for CSV files by looking for files with .csv extension..."

**Now**: ASR executes `find . -name "*.csv"` and reports: *"Found 30 CSV files: sample_data.csv with 9 lines, umath-validation-set-log2.csv with 1629 lines..."*

The system now provides **real, actionable information** instead of generic guidance!
