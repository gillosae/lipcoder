def calculate_area(radius):
    return 3.14159 * radius * radius

def calculate_perimeter(radius):
    return 2 * 3.14159 * radius

if __name__ == "__main__":
    r = 5
    area = calculate_area(r)
    perimeter = calculate_perimeter(r)
    print(f"Circle with radius {r}: area = {area}, perimeter = {perimeter}")
