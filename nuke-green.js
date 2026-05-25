const fs = require('fs');
const path = require('path');

const dirs = [
  'C:\\Users\\jaide\\OneDrive\\Desktop\\POS\\FrontPOS-main\\src\\app',
  'C:\\Users\\jaide\\OneDrive\\Desktop\\POS\\FrontPOS-main\\src\\components'
];

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
      results.push(file);
    }
  });
  return results;
}

let allFiles = [];
dirs.forEach(d => {
  allFiles = allFiles.concat(walk(d));
});

let modifiedFiles = 0;

allFiles.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let original = content;

  // Split into lines to conditionally replace
  let lines = content.split('\n');
  let newLines = lines.map(line => {
    // If it's a Button or explicitly says "Pagar" / "Guardar" / "+", we might keep it
    if (line.includes('<Button') || line.toLowerCase().includes('pagar') || line.toLowerCase().includes('guardar')) {
      return line;
    }
    
    // Replace bg-emerald-X and bg-green-X with bg-zinc-800 or bg-white/10
    let updatedLine = line.replace(/\bbg-emerald-\d+(?:\/\d+)?\b/g, 'bg-zinc-800 border border-white/5');
    updatedLine = updatedLine.replace(/\bbg-green-\d+(?:\/\d+)?\b/g, 'bg-zinc-800 border border-white/5');
    
    // Remove text-emerald entirely if any slipped through
    updatedLine = updatedLine.replace(/\btext-emerald-\d+\b/g, 'text-zinc-100');
    updatedLine = updatedLine.replace(/\btext-green-\d+\b/g, 'text-zinc-100');
    
    return updatedLine;
  });

  let newContent = newLines.join('\n');
  if (newContent !== original) {
    fs.writeFileSync(file, newContent, 'utf8');
    modifiedFiles++;
  }
});

console.log(`Nuked green from ${modifiedFiles} files.`);
