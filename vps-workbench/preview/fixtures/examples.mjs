const shopStyle = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f2eee5; color: #26382e; font: 15px/1.6 Georgia, serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 18px clamp(16px, 5vw, 52px); border-bottom: 1px solid #bdc0ad; }
  main { padding: clamp(22px, 7vw, 72px) clamp(16px, 5vw, 52px); }
  h1, h2, p { margin: 0 0 14px; }
  h1 { font-size: clamp(30px, 6vw, 62px); line-height: 1.1; }
  h2 { line-height: 1.4; }
  small { display: block; color: #4a6556; font: 700 12px/1.4 system-ui, sans-serif; }
  button { background: #294335; color: #fff9ed; border: 0; padding: 10px 16px; border-radius: 3px; }
  article { padding: 16px; background: #fffaf0; border-top: 3px solid #a06849; }
  .grid { margin-top: 30px; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
`;

function board(title, content) {
  return `~~~html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${title}</title><style>${shopStyle}</style></head>
<body>${content}</body>
</html>
~~~`;
}

export const storeBoard = board('纸间书店 · 首页', `
  <header><strong>纸间书店</strong><span>选书　/　活动　/　到店</span></header>
  <main>
    <small>独立书店 · 每周四至周日开放</small>
    <h1 id="hero-title">在纸页间，<br>留一个下午。</h1>
    <p id="hero-description">寻找一本新书，或与同桌聊聊正在读的那一本。</p>
    <button id="hero-action">查看本月荐书</button>
    <section class="grid" aria-label="书店近期活动">
      <article><small>店员荐书</small><h2>写给雨天的短篇</h2><p>三篇适合在返程路上读完的故事。</p></article>
      <article><small>周六读书会</small><h2>沿江散步</h2><p>带一本你愿意借给陌生人的书。</p></article>
    </section>
  </main>`);

export const eventBoard = board('纸间书店 · 活动详情', `
  <header><strong>纸间书店</strong><span>周末活动</span></header>
  <main>
    <small>周六 15:00–16:30</small>
    <h1 id="event-title">沿江散步读书会</h1>
    <p id="event-description">从店里出发，沿着江边走一小段。回来后，选一段文字读给大家听。</p>
    <button id="event-action">预约一个位置</button>
    <section class="grid" aria-label="活动信息">
      <article><h2>集合地点</h2><p>纸间书店二楼，开场前十分钟签到。</p></article>
      <article><h2>需要带什么</h2><p>一本想分享的书，以及适合散步的鞋。</p></article>
    </section>
  </main>`);

export const checkList = `## 周末上线前检查

1. 从项目导航进入活动页面，确认主按钮和返回路径。
2. 在桌面和窄屏上检查标题换行、长消息和键盘焦点。
3. 查看空状态，再打开一段已有的对话。

| 页面 | 验收点 |
| --- | --- |
| 活动详情 | 时间、地点和预约入口一屏可见 |
| 会话历史 | 切换项目后显示对应的对话 |

~~~text
准备 → 复核 → 发布
~~~

*这是用于浏览工作台的示例记录。*`;
