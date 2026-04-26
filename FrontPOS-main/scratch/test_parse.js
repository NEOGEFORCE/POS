const parser = require('@babel/parser');
const fs = require('fs');
const code = fs.readFileSync('c:/Users/jaide/Desktop/POS/FrontPOS-main/src/app/(app)/inventory/orders/page.tsx', 'utf8');

try {
  parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript']
  });
  console.log("Parse successful!");
} catch (e) {
  console.log(`Parse failed at line ${e.loc.line}, column ${e.loc.column}: ${e.message}`);
}
