import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, '..', 'src', 'App.tsx');
let app = fs.readFileSync(appPath, 'utf8');

// Comments (regex)
app = app.replace(
  /\/\*\* \? localhost[\s\S]*?\*\//,
  '/** 非 localhost 的 http://IP 不是安全上下文，浏览器不提供 crypto.randomUUID，首屏会白屏 */'
);
app = app.replace('/* ????????? */', '/* 部分环境仍可能抛错 */');
app = app.replace(
  /\/\*\* \?{5,}1\?2[\s\S]*?\*\//,
  '/** 按时间排序后，相邻奇偶打点成对为片段（1–2、3–4…）；奇数个时最后一段拉到视频结尾 */'
);
app = app.replace(
  /\/\*\* \?{5,} \*\/\r?\n  const \[videoListScope/,
  '/** 视频列表范围：全部已保存目录，或单个浏览目录 */\n  const [videoListScope'
);
app = app.replace(
  /\/\*\* \?{5,} \*\/\r?\n  const \[marksHydrated/,
  '/** 当前视频打点已从服务端加载，避免空状态覆盖磁盘缓存 */\n  const [marksHydrated'
);

const pairs = [
  ["useState('????????...')", "useState('允许根路径加载中...')"],
  ['`????????${roots.join', '`允许访问根：${roots.join'],
  ["setRootsHint('?????????')", "setRootsHint('当前没有可用根路径')"],
  [": '?????????')", ": '当前没有可用根路径')"],
  ["e.message : '?????')", "e.message : '初始化失败')"],
  ["e.message : '??????')", "e.message : '刷新列表失败')"],
  ["throw new Error('??????')", "throw new Error('无有效时间段')"],
  ["toast.error('??????');", "toast.error('无有效时间段');"],
  [
    "toast.success('????????????????????');",
    "toast.success('已加入任务队列，点击底部面板「开始」执行');",
  ],
  [
    "toast.success('????????????????');",
    "toast.success('已开始队列剪辑，可在底部查看进度');",
  ],
  ["toast.success('???????');", "toast.success('编码设置已保存');"],
  ["        : '??';", "        : '自动';"],
  ['??????? ? Kimi UI', '视频剪辑工作台 · Kimi UI'],
  ['?????? download', '来自网络存入 download'],
  ["err.message : '????')", "err.message : '上传失败')"],
  ['            ??\r\n', '            添加\r\n'],
  ['            ??\n', '            添加\n'],
  ['            ????\r\n', '            上传视频\r\n'],
  ['            ????\n', '            上传视频\n'],
  ['?? {encoderBadge}', '编码 {encoderBadge}'],
  [
    '            ????\r\n            {clipQueue',
    '            任务队列\r\n            {clipQueue',
  ],
  [
    '            ????\n            {clipQueue',
    '            任务队列\n            {clipQueue',
  ],
  ["label: `?? ${marks.length", "label: `标记 ${marks.length"],
  ["toast.error('??????');", "toast.error('请先添加打点');"],
  [
    '`??? ${marks.length} ????? ${next.length} ??????`',
    '`已根据 ${marks.length} 个打点生成 ${next.length} 个剪辑时间段`',
  ],
  [".join('?')", ".join('、')"],
  [
    "`${result.msg || '????'}??????${nums}?`",
    "`${result.msg || '部分完成'}，失败片段：${nums}）`",
  ],
  ["toast.success(result.msg || '??????');", "toast.success(result.msg || '批量剪辑完成');"],
  [".catch((e) => toast.error(e instanceof Error ? e.message : '????'))", ".catch((e) => toast.error(e instanceof Error ? e.message : '操作失败'))"],
  ["toast.info('????????');", "toast.info('正在重试失败片段');"],
  ["void addFolder(path)\r\n              .then(() => toast.success('?????'))", "void addFolder(path)\r\n              .then(() => toast.success('目录已保存'))"],
  ["void addFolder(path)\n              .then(() => toast.success('?????'))", "void addFolder(path)\n              .then(() => toast.success('目录已保存'))"],
  ["void removeFolder(path)\r\n              .then(() => toast.success('?????'))", "void removeFolder(path)\r\n              .then(() => toast.success('目录已移除'))"],
  ["void removeFolder(path)\n              .then(() => toast.success('?????'))", "void removeFolder(path)\n              .then(() => toast.success('目录已移除'))"],
  ["void openByPath(video.sourcePath)\r\n              .then(() => toast.success('?????'))", "void openByPath(video.sourcePath)\r\n              .then(() => toast.success('已加载视频'))"],
  ["void openByPath(video.sourcePath)\n              .then(() => toast.success('?????'))", "void openByPath(video.sourcePath)\n              .then(() => toast.success('已加载视频'))"],
  ["void openByPath(path)\r\n              .then(() => toast.success('?????'))", "void openByPath(path)\r\n              .then(() => toast.success('已加载视频'))"],
  ["void openByPath(path)\n              .then(() => toast.success('?????'))", "void openByPath(path)\n              .then(() => toast.success('已加载视频'))"],
];

for (const [from, to] of pairs) {
  if (app.includes(from)) app = app.split(from).join(to);
}

// Fix generic catch after specific success handlers
app = app.replace(
  /void addFolder\(path\)\s*\n\s*\.then\(\(\) => toast\.success\('目录已保存'\)\)\s*\n\s*\.catch\(\(e\) => toast\.error\(e instanceof Error \? e\.message : '操作失败'\)\)/g,
  "void addFolder(path)\n              .then(() => toast.success('目录已保存'))\n              .catch((e) => toast.error(e instanceof Error ? e.message : '添加失败'))"
);
app = app.replace(
  /void removeFolder\(path\)\s*\n\s*\.then\(\(\) => toast\.success\('目录已移除'\)\)\s*\n\s*\.catch\(\(e\) => toast\.error\(e instanceof Error \? e\.message : '操作失败'\)\)/g,
  "void removeFolder(path)\n              .then(() => toast.success('目录已移除'))\n              .catch((e) => toast.error(e instanceof Error ? e.message : '移除失败'))"
);
app = app.replace(
  /void openByPath\(video\.sourcePath\)\s*\n\s*\.then\(\(\) => toast\.success\('已加载视频'\)\)\s*\n\s*\.catch\(\(e\) => toast\.error\(e instanceof Error \? e\.message : '操作失败'\)\)/g,
  "void openByPath(video.sourcePath)\n              .then(() => toast.success('已加载视频'))\n              .catch((e) => toast.error(e instanceof Error ? e.message : '加载失败'))"
);
app = app.replace(
  /void refreshFoldersAndVideos\(\)\.catch\(\(e\) => toast\.error\(e instanceof Error \? e\.message : '操作失败'\)\)/g,
  "void refreshFoldersAndVideos().catch((e) => toast.error(e instanceof Error ? e.message : '刷新失败'))"
);
app = app.replace(
  /void openByPath\(path\)\s*\n\s*\.then\(\(\) => toast\.success\('已加载视频'\)\)\s*\n\s*\.catch\(\(e\) => toast\.error\(e instanceof Error \? e\.message : '操作失败'\)\)/g,
  "void openByPath(path)\n              .then(() => toast.success('已加载视频'))\n              .catch((e) => toast.error(e instanceof Error ? e.message : '加载失败'))"
);
app = app.replace(
  /\.catch\(\(e\) => toast\.error\(e instanceof Error \? e\.message : '操作失败'\)\)\s*\n\s*\.finally\(\(\) => setIsSubmitting\(false\)\);/g,
  ".catch((e) => toast.error(e instanceof Error ? e.message : '剪辑失败'))\n              .finally(() => setIsSubmitting(false));"
);

app = app.split('motionless-overlay').join('div');

fs.writeFileSync(appPath, app, 'utf8');
const left = app
  .split('\n')
  .filter((l) => /\?{2,}/.test(l) && !l.includes('?? 0') && !l.includes('?? 1'))
  .length;
console.log('remaining corrupted UI lines:', left);
