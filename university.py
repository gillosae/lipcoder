#!/usr/bin/env python3
"""
University Management System
A simple example for testing file opening functionality in lipcoder
"""

class University:
    def __init__(self, name: str, location: str):
        self.name = name
        self.location = location
        self.students = []
        self.faculty = []
        self.departments = []

    def add_student(self, student_name: str, student_id: str, major: str):
        """Add a new student to the university"""
        student = {
            'name': student_name,
            'id': student_id,
            'major': major,
            'enrolled_courses': []
        }
        self.students.append(student)
        return student

    def add_faculty(self, faculty_name: str, faculty_id: str, department: str):
        """Add a new faculty member"""
        faculty = {
            'name': faculty_name,
            'id': faculty_id,
            'department': department,
            'courses_taught': []
        }
        self.faculty.append(faculty)
        return faculty

    def create_department(self, dept_name: str, dept_head: str):
        """Create a new department"""
        department = {
            'name': dept_name,
            'head': dept_head,
            'courses': [],
            'faculty_count': 0,
            'student_count': 0
        }
        self.departments.append(department)
        return department

    def get_student_count(self) -> int:
        """Get total number of students"""
        return len(self.students)

    def get_faculty_count(self) -> int:
        """Get total number of faculty"""
        return len(self.faculty)

    def get_department_count(self) -> int:
        """Get total number of departments"""
        return len(self.departments)

    def __str__(self) -> str:
        return f"University: {self.name} ({self.location})"

    def __repr__(self) -> str:
        return f"University(name='{self.name}', location='{self.location}')"


def main():
    """Example usage of the University class"""
    # Create a university
    university = University("Tech University", "Silicon Valley")
    
    # Add some departments
    cs_dept = university.create_department("Computer Science", "Dr. Smith")
    math_dept = university.create_department("Mathematics", "Dr. Johnson")
    
    # Add faculty
    university.add_faculty("Dr. Alice Brown", "F001", "Computer Science")
    university.add_faculty("Dr. Bob Wilson", "F002", "Mathematics")
    
    # Add students
    university.add_student("John Doe", "S001", "Computer Science")
    university.add_student("Jane Smith", "S002", "Mathematics")
    university.add_student("Mike Johnson", "S003", "Computer Science")
    
    # Print university info
    print(university)
    print(f"Students: {university.get_student_count()}")
    print(f"Faculty: {university.get_faculty_count()}")
    print(f"Departments: {university.get_department_count()}")
    
    # List all students
    print("\nStudents:")
    for student in university.students:
        print(f"  - {student['name']} ({student['id']}) - {student['major']}")
    
    # List all faculty
    print("\nFaculty:")
    for faculty in university.faculty:
        print(f"  - {faculty['name']} ({faculty['id']}) - {faculty['department']}")


if __name__ == "__main__":
    main()
