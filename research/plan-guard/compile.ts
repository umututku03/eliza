// Compiles contracts/*.sol with solc 0.8.23 (the delegation framework's pragma), optimizer 200 runs, into build/.
// Usage: bun compile.ts
import solc from 'solc';
import {readdirSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

const dir = join(import.meta.dir, 'contracts');
const sources = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.sol')).map(f => [f, {content: readFileSync(join(dir, f), 'utf8')}]));
const input = {language: 'Solidity', sources, settings: {optimizer: {enabled: true, runs: 200}, evmVersion: 'shanghai',
  outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object']}}}};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e: any) => e.severity === 'error');
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
mkdirSync(join(import.meta.dir, 'build'), {recursive: true});
for (const [file, contracts] of Object.entries<any>(output.contracts))
  for (const [name, c] of Object.entries<any>(contracts)) {
    writeFileSync(join(import.meta.dir, 'build', `${name}.json`), JSON.stringify({abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, source: file, solc: solc.version()}, null, 2) + '\n');
    console.log(name, (c.evm.bytecode.object.length / 2) + ' bytes');
  }
