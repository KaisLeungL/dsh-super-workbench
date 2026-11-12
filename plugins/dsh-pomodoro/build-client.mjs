import { readFile, writeFile } from 'node:fs/promises';
import { createCompletionNotifier } from './completion-notifier.js';

const file = new URL('./client.js', import.meta.url);
const source = await readFile(file, 'utf8');
const start = '  // BEGIN completion notifier';
const end = '  // END completion notifier';
const a = source.indexOf(start);
const z = source.indexOf(end, a);
if (a < 0 || z < 0) throw new Error('Completion notifier build markers are missing.');
const output = source.slice(0, a) + start + '\n  ' + createCompletionNotifier.toString() + '\n' + end + source.slice(z + end.length);
if (output !== source) await writeFile(file, output);
