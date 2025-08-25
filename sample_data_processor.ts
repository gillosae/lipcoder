// Generated from CSV: sample_data.csv
interface SampleDataRecord {
    name: string;
    age: string;
    role: string;
    department: string;
    salary: string;
    joinDate: string;
}

async function processSampleData(csvFilePath: string): Promise<SampleDataRecord[]> {
    const fs = require('fs').promises;
    const content = await fs.readFile(csvFilePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
        return [];
    }
    
    // Skip header row
    const dataLines = lines.slice(1);
    const records: SampleDataRecord[] = [];
    
    for (const line of dataLines) {
        const values = line.split(',').map(v => v.trim());
        if (values.length === 6) {
            records.push({
                name: values[0],
                age: values[1],
                role: values[2],
                department: values[3],
                salary: values[4],
                joinDate: values[5]
            });
        }
    }
    
    return records;
}

// Example usage functions
async function findSampleDataRecordByField(records: SampleDataRecord[], field: keyof SampleDataRecord, value: string): Promise<SampleDataRecord[]> {
    return records.filter(record => record[field] === value);
}

async function getSampleDataRecordStatistics(records: SampleDataRecord[]): Promise<{total: number, fields: string[]}> {
    return {
        total: records.length,
        fields: ['name', 'age', 'role', 'department', 'salary', 'joinDate']
    };
}

// Additional utility functions for the employee data
async function getEmployeesByDepartment(records: SampleDataRecord[], department: string): Promise<SampleDataRecord[]> {
    return records.filter(record => record.department === department);
}

async function getAverageSalaryByDepartment(records: SampleDataRecord[]): Promise<{[department: string]: number}> {
    const departmentSalaries: {[key: string]: number[]} = {};
    
    for (const record of records) {
        const salary = parseInt(record.salary);
        if (!departmentSalaries[record.department]) {
            departmentSalaries[record.department] = [];
        }
        departmentSalaries[record.department].push(salary);
    }
    
    const averages: {[department: string]: number} = {};
    for (const [dept, salaries] of Object.entries(departmentSalaries)) {
        averages[dept] = salaries.reduce((sum, sal) => sum + sal, 0) / salaries.length;
    }
    
    return averages;
}

async function getEmployeesHiredAfter(records: SampleDataRecord[], date: string): Promise<SampleDataRecord[]> {
    const targetDate = new Date(date);
    return records.filter(record => {
        const hireDate = new Date(record.joinDate);
        return hireDate > targetDate;
    });
}

// Export the functions
export { processSampleData, findSampleDataRecordByField, getSampleDataRecordStatistics, getEmployeesByDepartment, getAverageSalaryByDepartment, getEmployeesHiredAfter };
export type { SampleDataRecord };
