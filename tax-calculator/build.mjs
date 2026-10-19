import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
export async function render() {
  const read = f => readFile(resolve(root,f), 'utf8');
  const [template,css,model,ui] = await Promise.all(['src/template.html','src/style.css','src/model.mjs','src/ui.js'].map(read));
  const script = model.replace(/^export /gm, '') + '\n' + ui;
  if (/<\/script/i.test(script)) throw new Error('Unsafe embedded script terminator');
  return template.replace('/* STYLE */', () => css).replace('/* APP */', () => script);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = await render();
  await writeFile(resolve(root, 'index.html'), html);
  console.log('Built self-contained index.html from the same exported model + UI source.');
}
