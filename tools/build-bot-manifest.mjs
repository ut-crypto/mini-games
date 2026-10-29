// shogi/arena/bots/ の .js ファイル一覧を index.json に書き出す
// (AI 対戦場は GitHub API で一覧を取るが、使えないときはこのファイルを使う)
import { readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'shogi', 'arena', 'bots');
const bots = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
writeFileSync(join(dir, 'index.json'), `${JSON.stringify({ bots }, null, 2)}\n`);
console.log(`index.json: ${bots.length} bots`);
