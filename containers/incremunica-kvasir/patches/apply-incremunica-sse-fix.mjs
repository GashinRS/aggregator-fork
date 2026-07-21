import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(
  packageRoot,
  'node_modules',
  '@incremunica',
  'actor-query-source-identify-graphql',
  'lib',
  'AsyncResourceIterator.js',
);

const original = `        const reader = response.body.getReader();
        let dataBuffer = '';
        const handleSSE = async () => {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    this.stopSource(type);
                    return;
                }
                dataBuffer += this.decoder.decode(Buffer.from(value));
                const parts = dataBuffer.split('\\n\\n');
                dataBuffer = '';
                for (const part of parts) {`;

const patched = `        const reader = response.body.getReader();
        // A ReadableStream chunk is not an SSE event boundary. Keep a local
        // streaming decoder and retain the final unterminated event fragment.
        const decoder = new TextDecoder('utf-8');
        let dataBuffer = '';
        const handleSSE = async () => {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    dataBuffer += decoder.decode();
                    if (dataBuffer.trim().length > 0) {
                        throw new Error(\`Subscription \${type} stream ended with an incomplete SSE event\`);
                    }
                    this.stopSource(type);
                    return;
                }
                dataBuffer += decoder.decode(value, { stream: true });
                const parts = dataBuffer.split(/\\r\\n\\r\\n|\\n\\n|\\r\\r/gu);
                dataBuffer = parts.pop() ?? '';
                for (const part of parts) {`;

const legacyDelimiterHandling = `                dataBuffer = dataBuffer.replace(/\\r\\n/gu, '\\n').replace(/\\r/gu, '\\n');
                const parts = dataBuffer.split('\\n\\n');`;
const patchedDelimiterHandling = `                const parts = dataBuffer.split(/\\r\\n\\r\\n|\\n\\n|\\r\\r/gu);`;

const source = await readFile(target, 'utf8');

if (source.includes(patched)) {
  console.log('Incremunica SSE framing fix already applied.');
} else if (source.includes(original)) {
  await writeFile(target, source.replace(original, patched), 'utf8');
  console.log('Applied Incremunica SSE framing fix.');
} else if (source.includes(legacyDelimiterHandling)) {
  await writeFile(
    target,
    source.replace(legacyDelimiterHandling, patchedDelimiterHandling),
    'utf8',
  );
  console.log('Updated Incremunica SSE framing fix.');
} else {
  throw new Error(
    `Refusing to patch unexpected Incremunica source at ${target}. ` +
    'Review the installed dependency before updating this patch.',
  );
}
