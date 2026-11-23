import { t } from '../../remote-workbench/vps-chat/client/interface-language.js';
import { localBackends } from '../local-sdk/providers.mjs';

export const componentWelcomeKey = 'dsh-vps-chat:component-welcome:v1';
export const componentMessages = {
  browse_only: '当前为仅浏览模式。请切换为可执行后重试。',
  component_busy: '已有本机配置操作正在进行。',
  component_cancelled: '安装已取消，可以重试。',
  component_platform_unavailable: '可选组件安装适用于 Windows x64。',
  component_download_failed: '下载中断。请检查本机网络后重试。',
  component_integrity_failed: '下载文件未通过完整性校验，请重试。',
  component_archive_invalid: '运行文件无法加载，请检查组件版本。',
  component_storage_failed: '无法保存组件或本机配置。请检查数据目录和剩余磁盘空间。',
  invalid_key: '请填写此执行端的有效 API 密钥。',
  credential_unavailable: '无法保存凭据或打开登录。请重试。',
};

const descriptions = {
  codex: 'OpenAI API 密钥',
  'claude-sdk': 'Anthropic API 密钥',
  antigravity: 'Google 账号 · 约 239 MB 下载',
};

export function useComponentInstall(React, { native, status, browsing, onContinue, onInstalled }) {
  const [selected, setSelected] = React.useState([]);
  const [pending, setPending] = React.useState(false);
  const [results, setResults] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const locked = React.useRef(false);
  const checked = selected.filter((id) => status?.items.some(({ backend, ready, available }) => backend === id && available && !ready));
  const disabled = browsing || pending || !status?.supported;
  function toggle(id) {
    setSelected((previous) => previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]);
  }
  async function install() {
    if (locked.current || !checked.length || disabled) return;
    locked.current = true;
    setProblem('');
    setPending(true);
    try {
      const result = await native.installLocalComponents(checked);
      if (result.results) {
        setResults(result.results);
        setSelected(result.results.filter(({ ok }) => !ok).map(({ backend }) => backend));
        await onInstalled(result.results.find(({ ok }) => ok)?.backend);
      } else setProblem(componentMessages[result.code] ?? '未能安装所选组件。');
    } catch { setProblem('未能读取安装结果。请检查组件状态后重试。'); }
    finally { locked.current = false; setPending(false); }
  }
  async function finish(openAccounts = false) {
    try { await onContinue(openAccounts); }
    catch { setProblem('无法保存首次接入选择，请重试。'); }
  }
  return { checked, pending, results, problem, disabled, toggle, install, finish };
}

export function createComponentPanel(React, button) {
  const h = React.createElement;
  return function ComponentPanel({ native, status, welcome, installation }) {
    if (!status) return null;
    const { checked, pending, results, problem, disabled, toggle, install, finish } = installation;
    const anyReady = status.items.some(({ ready }) => ready);
    return h('section', { className: 'vc-settings-group local-components', 'aria-label': t('可选本机组件'), 'aria-busy': pending },
      h('h4', null, t('可选本机组件')),
      h('p', null, t('勾选需要的执行端，一次下载、校验并创建只读本机配置。安装后可单独连接各自的账号。')),
      status.preview ? h('p', null, t('本地演示 · 使用模拟组件和预置账号。')) : null,
      h('fieldset', { className: 'local-component-list', disabled },
        h('legend', { className: 'local-component-legend' }, t('选择要安装的执行端')),
        status.items.map(({ backend, version, ready, available, source }) => {
          const result = results?.find((item) => item.backend === backend);
          const id = 'component-detail-' + backend;
          return h('label', { key: backend, className: 'local-component-card', 'data-ready': ready },
            h('input', { type: 'checkbox', checked: !ready && checked.includes(backend), disabled: ready || !available,
              'aria-label': localBackends[backend].label, 'aria-describedby': id, onChange: () => toggle(backend) }),
            h('span', { className: 'local-component-meta' },
              h('strong', null, localBackends[backend].label),
              h('span', { id }, 'v' + version + ' · ' + t(descriptions[backend])),
              result && !result.ok ? h('span', { role: 'alert' }, t(componentMessages[result.code] ?? '安装失败，请重试。')) : null),
            h('span', { className: 'local-component-status' }, ready ? t('已就绪') :
              !available ? t('记录不可用') : source ? t('待创建配置') : pending && checked.includes(backend) ? t('安装中') : t('未安装')));
        })),
      !status.supported ? h('p', { role: 'status' }, t(componentMessages.component_platform_unavailable)) : null,
      problem ? h('p', { className: 'vc-feedback', role: 'alert' }, problem) : null,
      h('div', { className: 'vc-setup-actions' },
        button(pending ? t('正在安装…') : t('安装所选组件'), { onClick: () => void install(), disabled: disabled || !checked.length }, 'vc-primary'),
        pending ? button(t('取消安装'), { onClick: () => void native.cancelLocalComponents().catch(() => {}) }) : null,
        anyReady ? button(t('前往模型与账号'), { disabled: pending, onClick: () => void finish(true) }) : null,
        welcome ? button(anyReady ? t('完成') : t('暂只使用 VPS SSH'), { disabled: pending, onClick: () => void finish() }) : null));
  };
}
