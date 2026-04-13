const fs = require('fs');
const content = fs.readFileSync('src/app/(app)/sales/returns/page.tsx', 'utf8');

function auditTags(content) {
    const stack = [];
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        
        // Find all tags in line
        const tagRegex = /<(\/?[a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
        let match;
        while ((match = tagRegex.exec(line)) !== null) {
            const tagName = match[1];
            const isClosing = tagName.startsWith('/');
            const isSelfClosing = match[2].endsWith('/');
            const name = isClosing ? tagName.substring(1) : tagName;
            
            if (isSelfClosing) continue;
            
            if (isClosing) {
                if (stack.length === 0) {
                    console.log(`Extra closing </${name}> at line ${lineNum}`);
                } else {
                    const last = stack.pop();
                    if (last.name !== name) {
                        console.log(`Mismatch: </${name}> at line ${lineNum} closed <${last.name}> from line ${last.line}`);
                    }
                }
            } else {
                stack.push({ name, line: lineNum });
            }
        }
    }
    
    while (stack.length > 0) {
        const remaining = stack.pop();
        console.log(`Unclosed <${remaining.name}> from line ${remaining.line}`);
    }
}

auditTags(content);
