
const fs = require('fs');
const content = fs.readFileSync('src/app/(app)/sales/returns/page.tsx', 'utf8');

function traceDivs(content) {
    const stack = [];
    const lines = content.split('\n');
    let foundReturn = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        if (line.includes('return (')) foundReturn = true;
        if (!foundReturn) continue;
        
        // Find all <div> or <div ...> (not self-closing)
        const openMatches = line.matchAll(/<div(\s|>)/g);
        for (const m of openMatches) {
            // Check if it's self-closing on the same line
            // This is a rough check
            const sub = line.substring(m.index);
            if (!sub.match(/^<div[^>]*\/>/)) {
                stack.push(lineNum);
            }
        }
        
        // Find all </div>
        const closeMatches = line.matchAll(/<\/div>/g);
        for (const m of closeMatches) {
            if (stack.length > 0) {
                stack.pop();
            } else {
                console.log(`Extra </div> at line ${lineNum}`);
            }
        }
    }
    
    console.log("Unclosed divs started at lines:", stack);
}

traceDivs(content);
