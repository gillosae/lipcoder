#!/bin/bash

# macOS Native TTS Master Generation Script
# Generates all voiceover files (alphabet, numbers, keywords, special chars) using macOS native TTS

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${PURPLE}🍎 macOS Native TTS Voiceover Generation Suite${NC}"
echo -e "${PURPLE}===============================================${NC}"

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}❌ Error: This script requires macOS${NC}"
    exit 1
fi

# Check if 'say' command is available
if ! command -v say &> /dev/null; then
    echo -e "${RED}❌ Error: macOS 'say' command not found${NC}"
    exit 1
fi

# Make all scripts executable
chmod +x alphabet_gen_macos.sh
chmod +x number_gen_macos.sh
chmod +x python_gen_macos.sh
chmod +x typescript_gen_macos.sh
chmod +x special_gen_macos.sh

echo -e "${BLUE}🔧 Starting macOS TTS voiceover generation...${NC}"
echo -e "${YELLOW}This will generate PCM files for:${NC}"
echo -e "  • Alphabet (a-z)"
echo -e "  • Numbers (0-9)"
echo -e "  • Python keywords"
echo -e "  • TypeScript keywords"
echo -e "  • Special characters"
echo ""

# Track timing
start_time=$(date +%s)

# Generate alphabet
echo -e "${BLUE}📝 Step 1/5: Generating alphabet...${NC}"
./alphabet_gen_macos.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Alphabet generation completed${NC}"
else
    echo -e "${RED}❌ Alphabet generation failed${NC}"
fi
echo ""

# Generate numbers
echo -e "${BLUE}🔢 Step 2/5: Generating numbers...${NC}"
./number_gen_macos.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Number generation completed${NC}"
else
    echo -e "${RED}❌ Number generation failed${NC}"
fi
echo ""

# Generate Python keywords
echo -e "${BLUE}🐍 Step 3/5: Generating Python keywords...${NC}"
./python_gen_macos.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Python keywords generation completed${NC}"
else
    echo -e "${RED}❌ Python keywords generation failed${NC}"
fi
echo ""

# Generate TypeScript keywords
echo -e "${BLUE}📘 Step 4/5: Generating TypeScript keywords...${NC}"
./typescript_gen_macos.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ TypeScript keywords generation completed${NC}"
else
    echo -e "${RED}❌ TypeScript keywords generation failed${NC}"
fi
echo ""

# Generate special characters
echo -e "${BLUE}🔣 Step 5/5: Generating special characters...${NC}"
./special_gen_macos.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Special characters generation completed${NC}"
else
    echo -e "${RED}❌ Special characters generation failed${NC}"
fi
echo ""

# Calculate timing
end_time=$(date +%s)
duration=$((end_time - start_time))

# Summary
echo -e "${PURPLE}🎉 macOS TTS Voiceover Generation Complete!${NC}"
echo -e "${PURPLE}===========================================${NC}"
echo -e "${BLUE}⏱️  Total time: ${duration} seconds${NC}"
echo ""

# Count generated files
alphabet_count=$(ls -1 alphabet_macos/*.pcm 2>/dev/null | wc -l)
number_count=$(ls -1 number_macos/*.pcm 2>/dev/null | wc -l)
python_count=$(ls -1 python_macos/*.pcm 2>/dev/null | wc -l)
typescript_count=$(ls -1 typescript_macos/*.pcm 2>/dev/null | wc -l)
special_count=$(ls -1 special_macos/*.pcm 2>/dev/null | wc -l)
total_count=$((alphabet_count + number_count + python_count + typescript_count + special_count))

echo -e "${YELLOW}📊 Generated Files Summary:${NC}"
echo -e "  • Alphabet: ${alphabet_count} files"
echo -e "  • Numbers: ${number_count} files"
echo -e "  • Python keywords: ${python_count} files"
echo -e "  • TypeScript keywords: ${typescript_count} files"
echo -e "  • Special characters: ${special_count} files"
echo -e "${GREEN}  📁 Total: ${total_count} PCM files${NC}"
echo ""

# Show directories created
echo -e "${YELLOW}📂 Directories created:${NC}"
for dir in alphabet_macos number_macos python_macos typescript_macos special_macos; do
    if [ -d "$dir" ]; then
        file_count=$(ls -1 "$dir"/*.pcm 2>/dev/null | wc -l)
        echo -e "  • ${dir}/ (${file_count} files)"
    fi
done
echo ""

echo -e "${GREEN}🎊 All macOS TTS voiceover files have been generated successfully!${NC}"
echo -e "${BLUE}💡 You can now use these PCM files with the LipCoder extension for fast, native macOS TTS playback.${NC}"
