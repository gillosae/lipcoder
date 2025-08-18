# Undo TTS Suppression Test File
# Instructions for testing:
# 1. Enable typing speech in lipcoder
# 2. Type some text in this file
# 3. Press Ctrl+Z (undo) - you should NOT hear excessive TTS
# 4. The undo detection should suppress TTS flooding

def example_function():
    """
    This is a test function for undo detection.
    Try typing some text here, then press Ctrl+Z to undo.
    The TTS should be suppressed during undo operations.
    """
    print("Hello, world!")
    return "test"

# Add some content to test undo operations
x = 1
y = 2
z = x + y
print(f"Result: {z}")

# More content for testing
for i in range(5):
    print(f"Number: {i}")

# Test multiline undo
if True:
    print("This is a multiline block")
    print("That can be undone")
    print("To test undo detection")
