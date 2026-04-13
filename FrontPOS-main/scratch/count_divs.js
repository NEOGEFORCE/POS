
const fs = require('fs');
const content = fs.readFileSync('src/app/(app)/sales/returns/page.tsx', 'utf8');

function countDivs(content) {
    let balance = 0;
    let lineNum = 1;
    let foundReturn = false;
    
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('return (')) foundReturn = true;
        if (!foundReturn) continue;
        
        // Primitive count ignoring typical generic markers but catching JSX
        // Match <div ...> or <div> but not something like <Sale[]>
        const opens = (line.match(/<div(\s|>)/g) || []).length;
        const closes = (line.match(/<\/div>/g) || []).length;
        const selfCloses = (line.match(/<div[^>]*\/>/g) || []).length;
        
        balance += opens;
        balance -= (closes + selfCloses);
        
        if (balance < 0) {
            console.log(`Balance dropped below zero at line ${i + 1}: ${line}`);
        }
    }
    console.log(`Final div balance: ${balance}`);
}

countDivs(content);
