#!/usr/bin/env python3

"""
Fix hardcoded Python paths in virtual environment scripts
This script updates all the shebang lines in Python virtual environment
to use the current project's path instead of hardcoded paths.
"""

import os
import sys
import re
from pathlib import Path

def fix_python_paths(venv_dir):
    """Fix hardcoded Python paths in virtual environment scripts"""
    
    # Get the current project directory
    current_dir = Path(__file__).parent.absolute()
    venv_path = current_dir / venv_dir
    
    if not venv_path.exists():
        print(f"Virtual environment directory not found: {venv_path}")
        return False
    
    bin_dir = venv_path / "bin"
    if not bin_dir.exists():
        print(f"Bin directory not found: {bin_dir}")
        return False
    
    # Pattern to match shebang lines with hardcoded paths
    shebang_pattern = re.compile(r'^#!/Users/[^/]+/Desktop/lipcoder/(.*)$')
    
    fixed_count = 0
    
    # Process all files in bin directory
    for file_path in bin_dir.iterdir():
        if file_path.is_file():
            try:
                # Read the file
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()
                
                if not lines:
                    continue
                
                # Check if first line is a shebang with hardcoded path
                first_line = lines[0].strip()
                match = shebang_pattern.match(first_line)
                
                if match:
                    # Extract the relative path part
                    relative_path = match.group(1)
                    
                    # Create new shebang with current directory
                    new_shebang = f"#!{current_dir}/{relative_path}"
                    
                    # Update the first line
                    lines[0] = new_shebang + '\n'
                    
                    # Write back to file
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.writelines(lines)
                    
                    print(f"Fixed: {file_path.name}")
                    print(f"  Old: {first_line}")
                    print(f"  New: {new_shebang}")
                    fixed_count += 1
                    
            except Exception as e:
                print(f"Error processing {file_path}: {e}")
                continue
    
    # Also fix activate scripts
    activate_files = [
        bin_dir / "activate",
        bin_dir / "activate.csh", 
        bin_dir / "activate.fish"
    ]
    
    for activate_file in activate_files:
        if activate_file.exists():
            try:
                with open(activate_file, 'r') as f:
                    content = f.read()
                
                # Pattern to match VIRTUAL_ENV paths
                venv_pattern = re.compile(r'VIRTUAL_ENV=/Users/[^/]+/Desktop/lipcoder/(.*)')
                
                def replace_venv_path(match):
                    relative_path = match.group(1)
                    return f'VIRTUAL_ENV={current_dir}/{relative_path}'
                
                new_content = venv_pattern.sub(replace_venv_path, content)
                
                if new_content != content:
                    with open(activate_file, 'w') as f:
                        f.write(new_content)
                    print(f"Fixed activate script: {activate_file.name}")
                    fixed_count += 1
                    
            except Exception as e:
                print(f"Error processing {activate_file}: {e}")
                continue
    
    print(f"\nFixed {fixed_count} files total")
    return fixed_count > 0

def main():
    """Main function"""
    if len(sys.argv) > 1:
        venv_dir = sys.argv[1]
    else:
        venv_dir = "client/src/python"
    
    print(f"Fixing Python paths in virtual environment: {venv_dir}")
    print(f"Current directory: {Path(__file__).parent.absolute()}")
    
    success = fix_python_paths(venv_dir)
    
    if success:
        print("\n✅ Successfully fixed Python paths!")
        print("The virtual environment should now work from any location.")
    else:
        print("\n❌ No paths were fixed or errors occurred.")
        return 1
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
