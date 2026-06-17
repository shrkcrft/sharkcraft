import { compressLog, InMemoryCcrStore } from "@shrkcrft/compress";

const lines: string[] = ['INFO start'];
for (let i = 0; i < 40; i += 1) lines.push(`INFO step ${i} doing routine work`);
lines.push('ERROR database connection refused at host db-1');
lines.push('Tests: 1 failed, 5 passed');
const text = lines.join('\n');

const store = new InMemoryCcrStore();
const result = compressLog(text, { store });
console.log("=== COMPRESSED OUTPUT ===");
console.log(result.compressed);
console.log("=== NOTE ===");
console.log(result.note);
console.log("=== CCR KEY ===");
console.log(result.ccrKey);
