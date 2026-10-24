"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.join(__dirname, "..", "index.js");
const source = fs.readFileSync(indexPath, "utf8");

test("el puerto serial sólo se escanea después de adquirir WS_PORT", () => {
    const listeningLog = source.indexOf("Servidor WebSocket escuchando");
    const scanInCallback = source.indexOf("scanAndConnect();", listeningLog);
    assert.ok(listeningLog >= 0 && scanInCallback > listeningLog,
        "el callback de listening debe iniciar scanAndConnect");

    const tail = source.slice(source.indexOf("function scheduleReconnect"));
    const directCalls = tail.match(/^scanAndConnect\(\);\s*$/gm) || [];
    assert.equal(directCalls.length, 0,
        "no debe existir scanAndConnect top-level: un duplicado sin WS retendría COM1");
});

test("EADDRINUSE termina el duplicado antes de que pueda retener COM1", () => {
    assert.match(source, /err\?\.code\s*===\s*["']EADDRINUSE["']/);
    assert.match(source, /process\.exit\(1\)/);
});
