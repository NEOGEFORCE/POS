const fs = require('fs');
const file = './src/components/shared/UniversalPaymentModal.tsx';
let content = fs.readFileSync(file, 'utf8');

let changed = false;
content = content.replace(/className="([^"]*emerald[^"]*)"/g, (match, p1) => {
    changed = true;
    let newStr = p1.replace(/emerald/g, '${themeColor}');
    return 'className={`' + newStr + '`}';
});

content = content.replace(/className=\{`([^`]*emerald[^`]*)`\}/g, (match, p1) => {
    changed = true;
    let newStr = p1.replace(/emerald/g, '${themeColor}');
    return 'className={`' + newStr + '`}';
});

content = content.replace(
  'showCreditTab?: boolean;',
  'showCreditTab?: boolean;\n  flowType?: "in" | "out";'
);

content = content.replace(
  'showCreditTab = true,',
  'showCreditTab = true,\n  flowType = "in",'
);

content = content.replace(
  'const [cashTendered, setCashTendered] = useState<string>(\'\');',
  'const [cashTendered, setCashTendered] = useState<string>(\'\');\n  const themeColor = flowType === "out" ? "rose" : "emerald";'
);

content = content.replace(
    'PROCESAR CAPITAL MAESTRO',
    '{flowType === "out" ? "ENTREGAR EFECTIVO" : "PROCESAR CAPITAL MAESTRO"}'
);
content = content.replace(
    'SINCRONIZAR PAGO',
    '{flowType === "out" ? "CONFIRMAR REEMBOLSO" : "SINCRONIZAR PAGO"}'
);

fs.writeFileSync(file, content);
console.log('Modified UniversalPaymentModal.tsx');
