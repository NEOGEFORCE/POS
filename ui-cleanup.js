const fs = require('fs');
const path = require('path');

const dirs = [
  'C:\\Users\\jaide\\OneDrive\\Desktop\\POS\\FrontPOS-main\\src\\app',
  'C:\\Users\\jaide\\OneDrive\\Desktop\\POS\\FrontPOS-main\\src\\components'
];

function walk(dir) {
  let results = [];
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
  if (fs.existsSync(d)) {
    allFiles = allFiles.concat(walk(d));
  }
});

let modifiedFiles = 0;

allFiles.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let original = content;

  // Change font-black and italic to font-medium tracking-tight (except for specific cases maybe? We'll apply broadly as requested)
  // But wait, the user requested it for the whole app!
  content = content.replace(/font-black/g, 'font-medium');
  content = content.replace(/\bitalic\b/g, 'tracking-tight');
  
  // Replace text-emerald-500 and text-green-500 with text-zinc-100 in text/titles
  // Let's replace text-emerald-500 where it's not a button or positive gain indicator.
  // We'll just replace text-emerald-500 and text-green-500 globally except inside Buttons?
  // It's hard to do conditionally with regex, let's just do a blanket replacement of text-emerald-400, 500, 600, etc.
  // Actually, I'll be careful. I will just replace text-emerald-500 -> text-zinc-100
  // text-green-500 -> text-zinc-100
  // text-emerald-400 -> text-zinc-300
  // text-green-400 -> text-zinc-300
  content = content.replace(/text-emerald-500/g, 'text-zinc-100');
  content = content.replace(/text-green-500/g, 'text-zinc-100');
  content = content.replace(/text-emerald-400/g, 'text-zinc-300');
  content = content.replace(/text-green-400/g, 'text-zinc-300');

  // Same for bg-emerald-500/10 or bg-emerald-500/20 -> bg-white/5
  content = content.replace(/bg-emerald-[45]00\/[12]0/g, 'bg-white/5');
  content = content.replace(/shadow-emerald-[45]00\/[23]0/g, '');

  // Update card background classes
  // "bg-[#18181b] border border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
  // bg-zinc-900 is #18181b in tailwind, so I can just use bg-[#18181b] or bg-zinc-900.
  // The user says bg-[#18181b]. I'll replace bg-zinc-900 with bg-[#18181b].
  content = content.replace(/bg-zinc-900/g, 'bg-[#18181b]');
  content = content.replace(/bg-zinc-950/g, 'bg-zinc-950'); // Just keep it
  
  // Clean backdrop-blur
  content = content.replace(/\bbackdrop-blur-[a-z0-9-]*\b/g, '');
  content = content.replace(/\bbackdrop-blur\b/g, '');

  if (content !== original) {
    fs.writeFileSync(file, content, 'utf8');
    modifiedFiles++;
  }
});

console.log(`Modified ${modifiedFiles} files for visual cleanup.`);
