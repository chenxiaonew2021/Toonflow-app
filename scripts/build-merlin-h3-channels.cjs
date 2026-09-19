// 两个供应商共用一份协议源码；输出文件保存在 Toonflow 的 vendor 目录。
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireToon = createRequire(path.resolve(__dirname, '../package.json'));
const source = fs.readFileSync(path.join(__dirname, 'templates/merlin-minimax-h3.ts'), 'utf8');
const js = requireToon('sucrase').transform(source, { transforms: ['typescript'] }).code.replace(/export\s*\{\s*\};?/g, '');
const output = {};
new (requireToon('vm2').VM)({ sandbox: { exports: output } }).run(js);
for (const [index, channel, label, description] of [
  [0, 'fl2va', 'FL2VA', '本地直连 zj-minimax-h3-fl2va。首帧、尾帧均可选：不传图、仅首帧、仅尾帧或两帧都传。无图时使用 T2VA。768P，4–15 秒，原生音画生成。'],
  [1, 'ref2va', 'Ref2VA', '本地直连 zj-minimax-h3-rel2va。支持 1–8 张参考图片，或一段参考视频；图片与视频不能混用。768P，4–15 秒，原生音画生成。'],
]) {
  const vendor = JSON.parse(JSON.stringify(output.vendor));
  vendor.id += channel;
  vendor.name = `Merlin H3 · ${label}`;
  vendor.description = description;
  vendor.models = [vendor.models[index]];
  const pattern = /const vendor = \{[\s\S]*?\n\};/;
  if (!pattern.test(source)) throw new Error('供应商模板不匹配');
  const code = source.replace(pattern, () => `const vendor = ${JSON.stringify(vendor, null, 2)};`);
  fs.writeFileSync(path.join(__dirname, `../data/vendor/merlinminimaxh3${channel}.ts`), '// 由 scripts/build-merlin-h3-channels.cjs 生成；模板位于 scripts/templates/merlin-minimax-h3.ts。\n' + code);
}
